import type {
  GpuBindGroup,
  GpuBindGroupEntry,
  GpuBuffer,
  GpuComputePassEncoder,
  GpuComputePipeline,
  PhysicalBindGroup,
  PhysicalUniformBlock,
  RenderBackend,
  UniformValue,
} from '@fdw/engine-backend';
import type { CompiledProgram } from '@fdw/engine-shader';
import type { MaterialValue } from '../render/Material';

export interface ComputeDispatch {
  // The resources of the program, by name: uniform values (members of its
  // uniform blocks), textures, samplers and storage buffers.
  readonly values?: Readonly<Record<string, MaterialValue>>;
  // The number of workgroups in x, y and z, or a buffer holding them (three
  // u32, written by the GPU) for an indirect dispatch.
  readonly workgroups:
    | readonly [number, number?, number?]
    | { readonly buffer: GpuBuffer; readonly offset?: number };
  // The dispatches of a submission binding the same resources share their
  // uniform values; those of different owners do not (the steps of a loop,
  // the materials of a graph, each with its own uniforms).
  readonly owner?: object;
}

export interface ComputeRunnerOptions {
  // Bind groups kept for reuse: the least recently used beyond are
  // destroyed. More than the groups a submission binds (with record): those
  // of its first dispatches would be freed before it. Default 256.
  readonly bindGroups?: number;
  // The programs tracing rays as ray tracing pipelines, where the backend
  // has them (see ComputePipelineDescriptor.rayTracing). Default false.
  readonly rayTracing?: boolean;
}

const isUniformValue = (value: MaterialValue | undefined): boolean =>
  typeof value === 'number' ||
  typeof value === 'boolean' ||
  (typeof value === 'object' && value !== null && 'length' in value);

// A bind group of a program, for a set of resources, and the uniform
// buffers it binds.
interface CachedGroup {
  readonly bindGroup: GpuBindGroup;
  readonly uniforms: readonly {
    readonly buffer: GpuBuffer;
    readonly block: PhysicalUniformBlock;
  }[];
}

// Runs compiled compute graphs: on their own (dispatch, for tests and
// one-off processing), or in the compute pass of a render graph (record).
// Pipelines are created on first use and cached by program; bind groups and
// their uniform buffers by program, group and resources, reused from one
// dispatch to the next.
export class ComputeRunner {
  private readonly _pipelines = new Map<string, GpuComputePipeline>();
  // Most recently used last.
  private readonly _groups = new Map<string, CachedGroup>();
  private readonly _ids = new WeakMap<object, number>();
  private _nextId = 1;
  private readonly _maxGroups: number;
  private readonly _rayTracing: boolean;

  constructor(
    readonly backend: RenderBackend,
    options: ComputeRunnerOptions = {},
  ) {
    this._maxGroups = options.bindGroups ?? 256;
    this._rayTracing = options.rayTracing ?? false;
  }

  // Records and submits a dispatch of the program. Its results can be read
  // back with buffer.read().
  dispatch(program: CompiledProgram, dispatch: ComputeDispatch): void {
    const encoder = this.backend.createCommandEncoder();
    const pass = encoder.beginComputePass(program.name);
    this.record(pass, program, dispatch);
    pass.end();
    this.backend.submit([encoder.finish()]);
  }

  // Records a dispatch of the program in a compute pass (of a render graph):
  // submitted with it. The dispatches of a submission that bind the same
  // resources share their uniform values: the last ones written.
  record(
    pass: GpuComputePassEncoder,
    program: CompiledProgram,
    { values = {}, workgroups, owner }: ComputeDispatch,
  ): void {
    const { pipelines } = this.backend;
    let pipeline = this._pipelines.get(program.programKey);
    if (!pipeline) {
      pipeline = pipelines.createComputePipeline({
        program,
        ...(this._rayTracing ? { rayTracing: true } : {}),
      });
      this._pipelines.set(program.programKey, pipeline);
    }
    pass.setPipeline(pipeline);
    for (const group of pipelines.resolveLayout(program).groups) {
      pass.setBindGroup(
        group.index,
        this.bindGroup(program, group, values, owner),
      );
    }
    if (Array.isArray(workgroups)) {
      const [x, y = 1, z = 1] = workgroups as readonly number[];
      pass.dispatchWorkgroups(x, y, z);
    } else {
      const { buffer, offset = 0 } = workgroups as {
        buffer: GpuBuffer;
        offset?: number;
      };
      pass.dispatchWorkgroupsIndirect(buffer, offset);
    }
  }

  // Bind groups in the cache, for tests and diagnostics.
  get bindGroups(): number {
    return this._groups.size;
  }

  // Once the submitted dispatches are recorded: frees the bind groups and
  // the uniform buffers.
  destroy(): void {
    for (const cached of this._groups.values()) {
      this.free(cached);
    }
    this._groups.clear();
    this._pipelines.clear();
  }

  // The bind group of a group of the program for the given resources, from
  // the cache, its uniform blocks written with the given values (members
  // without value stay at zero).
  private bindGroup(
    program: CompiledProgram,
    group: PhysicalBindGroup,
    values: Readonly<Record<string, MaterialValue>>,
    owner?: object,
  ): GpuBindGroup {
    const resources: GpuBindGroupEntry['resource'][] = [];
    let key = `${program.programKey}:${group.index}${
      owner ? `@${this.id(owner)}` : ''
    }`;
    for (const binding of group.bindings) {
      if (binding.block) {
        continue;
      }
      const value = values[binding.resource.name];
      if (value === undefined || isUniformValue(value)) {
        throw new Error(
          `Compute "${program.name}": no ${binding.resource.kind} given for "${binding.resource.name}"`,
        );
      }
      const resource = value as GpuBindGroupEntry['resource'];
      resources.push(resource);
      // A structure whose memory was replaced binds anew.
      const version = (resource as { version?: unknown }).version;
      key += `:${this.id(resource)}${
        typeof version === 'number' && 'instanceCount' in resource
          ? `v${version}`
          : ''
      }`;
    }

    let cached = this._groups.get(key);
    if (cached) {
      this._groups.delete(key);
    } else {
      cached = this.createGroup(group, resources);
      if (this._groups.size >= this._maxGroups) {
        const [oldest, evicted] = this._groups.entries().next().value as [
          string,
          CachedGroup,
        ];
        this._groups.delete(oldest);
        // Its last dispatches were recorded: freed after their submission.
        this.free(evicted);
      }
    }
    this._groups.set(key, cached);

    for (const { buffer, block } of cached.uniforms) {
      buffer.write(0, this.uniformData(block, values));
    }
    return cached.bindGroup;
  }

  private createGroup(
    group: PhysicalBindGroup,
    resources: readonly GpuBindGroupEntry['resource'][],
  ): CachedGroup {
    const { pipelines } = this.backend;
    const uniforms: CachedGroup['uniforms'][number][] = [];
    let next = 0;
    const entries = group.bindings.map((binding): GpuBindGroupEntry => {
      if (binding.block) {
        const buffer = this.backend.buffers.create({
          label: 'compute uniforms',
          size: binding.block.size,
          usage: ['uniform', 'copy-dst'],
        });
        uniforms.push({ buffer, block: binding.block });
        return { binding: binding.binding, resource: buffer };
      }
      return { binding: binding.binding, resource: resources[next++] };
    });
    return {
      bindGroup: pipelines.createBindGroup(
        pipelines.createBindGroupLayout(group),
        entries,
      ),
      uniforms,
    };
  }

  private free(cached: CachedGroup): void {
    cached.bindGroup.destroy?.();
    for (const { buffer } of cached.uniforms) {
      buffer.destroy();
    }
  }

  // A number identifying a resource in the keys of the cache.
  private id(resource: object): number {
    let id = this._ids.get(resource);
    if (id === undefined) {
      id = this._nextId++;
      this._ids.set(resource, id);
    }
    return id;
  }

  private uniformData(
    block: PhysicalUniformBlock,
    values: Readonly<Record<string, MaterialValue>>,
  ): ArrayBuffer {
    const data = new DataView(new ArrayBuffer(block.size));
    for (const member of block.members) {
      const value = values[member.name];
      if (value !== undefined) {
        if (!isUniformValue(value)) {
          throw new Error(`"${member.name}" is a uniform, not a resource`);
        }
        this.backend.pipelines.layoutStrategy.writeUniform(
          data,
          member,
          value as UniformValue,
        );
      }
    }
    return data.buffer;
  }
}
