import {
  ComputePipelineDescriptor,
  GpuBindGroup,
  GpuBindGroupEntry,
  GpuBindGroupLayout,
  GpuComputePipeline,
  GpuPipelineFactory,
  GpuRenderPipeline,
  matchVertexLayout,
  PhysicalBindGroup,
  PhysicalProgramLayout,
  RenderPipelineDescriptor,
  std140LayoutStrategy,
} from '@fdw/engine-backend';
import type { CompiledProgram, LogicalBinding } from '@fdw/engine-shader';
import {
  BindingKinds,
  ContextHandle,
  GroupHandle,
  GroupLayoutHandle,
  PipelineHandle,
  ShaderHandle,
  VulkanAddon,
} from '../addon';
import { VulkanBuffer } from '../gpu/VulkanBuffer';
import { VulkanSampler, VulkanTexture } from '../gpu/VulkanTexture';
import { dxcArguments, HlslCodegen } from '../shader/HlslCodegen';
import { VulkanObjectTable } from './VulkanObjectTable';

const bindingKind = (resource: LogicalBinding): number => {
  switch (resource.kind) {
    case 'uniform-block':
      return BindingKinds.uniform;
    case 'texture':
      return BindingKinds.texture;
    case 'sampler':
      return BindingKinds.sampler;
    case 'storage-buffer':
      return resource.access === 'read-write'
        ? BindingKinds.storageReadWrite
        : BindingKinds.storageRead;
    case 'object-table':
      // Two bindings: see the layout of the group.
      return BindingKinds.storageRead;
  }
};

export class VulkanBindGroupLayout implements GpuBindGroupLayout {
  constructor(
    readonly key: string,
    readonly handle: GroupLayoutHandle,
  ) {}
}

export class VulkanBindGroup implements GpuBindGroup {
  private _destroyed = false;

  constructor(
    readonly layout: VulkanBindGroupLayout,
    readonly handle: GroupHandle,
    // Identifies the group in the commands.
    readonly id: number,
    private readonly _addon: VulkanAddon,
  ) {}

  // Frees the descriptor set once the GPU no longer uses it.
  destroy(): void {
    if (!this._destroyed) {
      this._destroyed = true;
      this._addon.destroyGroup(this.handle);
    }
  }
}

export class VulkanRenderPipeline implements GpuRenderPipeline {
  constructor(
    readonly handle: PipelineHandle,
    readonly id: number,
    readonly vertexBuffers: readonly number[],
    readonly label?: string,
  ) {}
}

export class VulkanComputePipeline implements GpuComputePipeline {
  constructor(
    readonly handle: PipelineHandle,
    readonly id: number,
    readonly label?: string,
  ) {}
}

// The id of a resource of a bind group entry.
function resourceId(entry: GpuBindGroupEntry): number {
  const { resource } = entry;
  if (
    resource instanceof VulkanBuffer ||
    resource instanceof VulkanTexture ||
    resource instanceof VulkanSampler
  ) {
    return resource.id;
  }
  throw new Error(
    `The resource of binding ${entry.binding} was not created by the Vulkan backend`,
  );
}

/**
 * Programs, layouts and pipelines: HLSL generated from the programs,
 * compiled to SPIR-V by the DXC library of the native side; the layouts of
 * the GLSL family (std140 uniform blocks, groups as descriptor sets).
 */
export class VulkanPipelineFactory implements GpuPipelineFactory {
  readonly codegen = new HlslCodegen();
  readonly layoutStrategy = std140LayoutStrategy;
  private readonly _layouts = new Map<string, PhysicalProgramLayout>();
  private readonly _groupLayouts = new Map<string, VulkanBindGroupLayout>();
  // The shader modules of each program, by program key.
  private readonly _shaders = new Map<
    string,
    { vertex: ShaderHandle; fragment: ShaderHandle }
  >();
  private readonly _computeShaders = new Map<string, ShaderHandle>();

  constructor(
    private readonly _addon: VulkanAddon,
    private readonly _context: ContextHandle,
  ) {}

  resolveLayout(program: CompiledProgram): PhysicalProgramLayout {
    let layout = this._layouts.get(program.programKey);
    if (!layout) {
      layout = this.layoutStrategy.resolve(program.layout);
      this._layouts.set(program.programKey, layout);
    }
    return layout;
  }

  createRenderPipeline(
    descriptor: RenderPipelineDescriptor,
  ): VulkanRenderPipeline {
    const { program, primitive, depthStencil, targets } = descriptor;
    const layout = this.resolveLayout(program);
    const shaders = this.renderShaders(program, layout);
    const buffers = matchVertexLayout(program.vertexInputs, descriptor.vertex);
    const label = descriptor.label ?? program.name;
    const handle = this._addon.createRenderPipeline(this._context, {
      vertex: shaders.vertex,
      fragment: shaders.fragment,
      groups: this.groupLayouts(layout),
      vertexBuffers: buffers.map((buffer) => ({
        stride: buffer.stride,
        perInstance: buffer.stepMode === 'instance',
        attributes: buffer.attributes,
      })),
      topology: primitive.topology,
      cullMode: primitive.cullMode,
      frontFace: primitive.frontFace,
      ...(depthStencil
        ? {
            depthFormat: depthStencil.format,
            depthWrite: depthStencil.depthWrite,
            depthCompare: depthStencil.depthCompare,
            depthBias: depthStencil.depthBias ?? 0,
            depthBiasSlopeScale: depthStencil.depthBiasSlopeScale ?? 0,
          }
        : {}),
      targets: targets.map((target) => ({
        format: target.format,
        ...(target.blend ? { blend: target.blend } : {}),
      })),
      sampleCount: descriptor.sampleCount ?? 1,
      label,
    });
    return new VulkanRenderPipeline(
      handle,
      this._addon.pipelineId(handle),
      buffers.map((buffer) => buffer.buffer),
      label,
    );
  }

  async createRenderPipelineAsync(
    descriptor: RenderPipelineDescriptor,
  ): Promise<GpuRenderPipeline> {
    return this.createRenderPipeline(descriptor);
  }

  createComputePipeline({
    program,
    label,
  }: ComputePipelineDescriptor): VulkanComputePipeline {
    const layout = this.resolveLayout(program);
    let shader = this._computeShaders.get(program.programKey);
    if (!shader) {
      const sources = this.codegen.emit(program.module, layout);
      const entryPoint =
        sources.kind === 'single-module'
          ? sources.entryPoints.compute
          : undefined;
      if (sources.kind !== 'single-module' || !entryPoint) {
        throw new Error(`Program "${program.name}" has no compute stage`);
      }
      shader = this._addon.createShader(
        this._context,
        sources.code,
        dxcArguments('compute', entryPoint),
        `${program.name} (compute)`,
      );
      this._computeShaders.set(program.programKey, shader);
    }
    const name = label ?? program.name;
    const handle = this._addon.createComputePipeline(
      this._context,
      shader,
      this.groupLayouts(layout),
      name,
    );
    return new VulkanComputePipeline(
      handle,
      this._addon.pipelineId(handle),
      name,
    );
  }

  async createComputePipelineAsync(
    descriptor: ComputePipelineDescriptor,
  ): Promise<GpuComputePipeline> {
    return this.createComputePipeline(descriptor);
  }

  createBindGroupLayout(group: PhysicalBindGroup): VulkanBindGroupLayout {
    // An object table: the rows, then the row of each instance.
    const bindings = group.bindings.flatMap(({ binding, resource }) =>
      resource.kind === 'object-table'
        ? [0, 1].map((offset) => ({
            binding: binding + offset,
            kind: BindingKinds.storageRead,
          }))
        : [{ binding, kind: bindingKind(resource) }],
    );
    const key = JSON.stringify(bindings);
    let layout = this._groupLayouts.get(key);
    if (!layout) {
      layout = new VulkanBindGroupLayout(
        key,
        this._addon.createGroupLayout(this._context, bindings),
      );
      this._groupLayouts.set(key, layout);
    }
    return layout;
  }

  createBindGroup(
    layout: GpuBindGroupLayout,
    entries: readonly GpuBindGroupEntry[],
  ): VulkanBindGroup {
    if (!(layout instanceof VulkanBindGroupLayout)) {
      throw new Error('The layout was not created by the Vulkan backend');
    }
    const handle = this._addon.createGroup(
      this._context,
      layout.handle,
      entries.flatMap((entry) =>
        entry.resource instanceof VulkanObjectTable
          ? [
              { binding: entry.binding, object: entry.resource.rowBuffer.id },
              {
                binding: entry.binding + 1,
                object: entry.resource.instanceBuffer.id,
              },
            ]
          : [{ binding: entry.binding, object: resourceId(entry) }],
      ),
    );
    return new VulkanBindGroup(
      layout,
      handle,
      this._addon.groupId(handle),
      this._addon,
    );
  }

  // The layouts of the groups of a program (null for the empty ones).
  private groupLayouts(
    layout: PhysicalProgramLayout,
  ): (GroupLayoutHandle | null)[] {
    return layout.groups.map((group) =>
      group.bindings.length > 0
        ? this.createBindGroupLayout(group).handle
        : null,
    );
  }

  // The vertex and fragment shader modules of a program, compiled once.
  private renderShaders(
    program: CompiledProgram,
    layout: PhysicalProgramLayout,
  ): { vertex: ShaderHandle; fragment: ShaderHandle } {
    let shaders = this._shaders.get(program.programKey);
    if (!shaders) {
      const sources = this.codegen.emit(program.module, layout);
      if (
        sources.kind !== 'single-module' ||
        !sources.entryPoints.vertex ||
        !sources.entryPoints.fragment
      ) {
        throw new Error(
          `Program "${program.name}" has no vertex and fragment stages`,
        );
      }
      const compile = (stage: 'vertex' | 'fragment', entryPoint: string) =>
        this._addon.createShader(
          this._context,
          sources.code,
          dxcArguments(stage, entryPoint),
          `${program.name} (${stage})`,
        );
      shaders = {
        vertex: compile('vertex', sources.entryPoints.vertex),
        fragment: compile('fragment', sources.entryPoints.fragment),
      };
      this._shaders.set(program.programKey, shaders);
    }
    return shaders;
  }
}
