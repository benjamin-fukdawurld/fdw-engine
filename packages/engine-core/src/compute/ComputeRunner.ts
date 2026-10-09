import type {
  GpuBindGroupEntry,
  GpuBuffer,
  GpuComputePipeline,
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
}

const isUniformValue = (value: MaterialValue | undefined): boolean =>
  typeof value === 'number' ||
  typeof value === 'boolean' ||
  (typeof value === 'object' && value !== null && 'length' in value);

// Runs compiled compute graphs outside of a render graph: for tests and
// one-off processing. Pipelines and uniform buffers are created on first use
// and cached by program.
export class ComputeRunner {
  private readonly _pipelines = new Map<string, GpuComputePipeline>();
  private readonly _uniformBuffers = new Map<string, GpuBuffer>();

  constructor(readonly backend: RenderBackend) {}

  // Records and submits a dispatch of the program. Its results can be read
  // back with buffer.read().
  dispatch(
    program: CompiledProgram,
    { values = {}, workgroups }: ComputeDispatch
  ): void {
    const { pipelines } = this.backend;
    let pipeline = this._pipelines.get(program.programKey);
    if (!pipeline) {
      pipeline = pipelines.createComputePipeline({ program });
      this._pipelines.set(program.programKey, pipeline);
    }

    const encoder = this.backend.createCommandEncoder();
    const pass = encoder.beginComputePass(program.name);
    pass.setPipeline(pipeline);
    for (const group of pipelines.resolveLayout(program).groups) {
      const entries: GpuBindGroupEntry[] = group.bindings.map((binding) => {
        if (binding.block) {
          return {
            binding: binding.binding,
            resource: this.uniformBuffer(
              `${program.programKey}:${group.index}:${binding.binding}`,
              binding.block,
              values
            ),
          };
        }
        const value = values[binding.resource.name];
        if (value === undefined || isUniformValue(value)) {
          throw new Error(
            `Compute "${program.name}": no ${binding.resource.kind} given for "${binding.resource.name}"`
          );
        }
        return {
          binding: binding.binding,
          resource: value as GpuBindGroupEntry['resource'],
        };
      });
      pass.setBindGroup(
        group.index,
        pipelines.createBindGroup(
          pipelines.createBindGroupLayout(group),
          entries
        )
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
    pass.end();
    this.backend.submit([encoder.finish()]);
  }

  destroy(): void {
    for (const buffer of this._uniformBuffers.values()) {
      buffer.destroy();
    }
    this._uniformBuffers.clear();
    this._pipelines.clear();
  }

  // A uniform block of the program, written with the given values (members
  // without value stay at zero).
  private uniformBuffer(
    key: string,
    block: PhysicalUniformBlock,
    values: Readonly<Record<string, MaterialValue>>
  ): GpuBuffer {
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
          value as UniformValue
        );
      }
    }
    let buffer = this._uniformBuffers.get(key);
    if (!buffer) {
      buffer = this.backend.buffers.create({
        label: 'compute uniforms',
        size: block.size,
        usage: ['uniform', 'copy-dst'],
      });
      this._uniformBuffers.set(key, buffer);
    }
    buffer.write(0, data.buffer);
    return buffer;
  }
}
