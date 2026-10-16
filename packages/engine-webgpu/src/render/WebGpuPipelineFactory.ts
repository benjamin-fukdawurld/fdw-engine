import {
  ComputePipelineDescriptor,
  GpuComputePipeline,
  GpuBindGroup,
  GpuBindGroupEntry,
  GpuBindGroupLayout,
  GpuPipelineFactory,
  GpuRenderPipeline,
  matchVertexLayout,
  PhysicalBindGroup,
  PhysicalBinding,
  PhysicalProgramLayout,
  RenderPipelineDescriptor,
} from '@fdw/engine-backend';
import type { CompiledProgram } from '@fdw/engine-shader';
import { Buffer } from '../gpu/BufferFactory';
import { Sampler } from '../gpu/Sampler';
import { Texture } from '../gpu/Texture';
import { WgslCodegen } from '../shader/WgslCodegen';
import { wgslLayoutStrategy } from '../shader/wgslLayoutStrategy';
import { WebGpuObjectTable } from './WebGpuObjectTable';

export class WebGpuRenderPipeline implements GpuRenderPipeline {
  constructor(
    readonly pipeline: GPURenderPipeline,
    readonly vertexBuffers: readonly number[],
    readonly label?: string,
  ) {}
}

export class WebGpuComputePipeline implements GpuComputePipeline {
  constructor(
    readonly pipeline: GPUComputePipeline,
    readonly label?: string,
  ) {}
}

export class WebGpuBindGroupLayout implements GpuBindGroupLayout {
  constructor(
    readonly key: string,
    readonly layout: GPUBindGroupLayout,
  ) {}
}

export class WebGpuBindGroup implements GpuBindGroup {
  constructor(
    readonly layout: WebGpuBindGroupLayout,
    readonly group: GPUBindGroup,
  ) {}
}

// The entries of a binding: one, or two for an object table (the rows, then
// the row of each instance).
function layoutEntries(binding: PhysicalBinding): GPUBindGroupLayoutEntry[] {
  if (binding.resource.kind === 'object-table') {
    const visibility = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    return [0, 1].map((offset) => ({
      binding: binding.binding + offset,
      visibility,
      buffer: { type: 'read-only-storage' },
    }));
  }
  return [layoutEntry(binding)];
}

function layoutEntry(binding: PhysicalBinding): GPUBindGroupLayoutEntry {
  // Programs do not say which stage reads which resource yet: every stage
  // that can see the resource does, so that groups are shared between render
  // and compute pipelines.
  const visibility =
    GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE;
  const { resource } = binding;
  switch (resource.kind) {
    case 'uniform-block':
      return {
        binding: binding.binding,
        visibility,
        buffer: { type: 'uniform', minBindingSize: binding.block?.size },
      };
    case 'texture':
      return {
        binding: binding.binding,
        visibility,
        texture: {
          sampleType: resource.type.sampleType,
          viewDimension: resource.type.dimension,
          multisampled: resource.type.multisampled ?? false,
        },
      };
    case 'sampler':
      return {
        binding: binding.binding,
        visibility,
        sampler: { type: resource.comparison ? 'comparison' : 'filtering' },
      };
    case 'object-table':
      throw new Error('An object table has two entries: see layoutEntries');
    case 'storage-buffer':
      return resource.access === 'read-write'
        ? {
            binding: binding.binding,
            // Vertex stages cannot write storage buffers.
            visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
            buffer: { type: 'storage' },
          }
        : {
            binding: binding.binding,
            visibility,
            buffer: { type: 'read-only-storage' },
          };
  }
}

function bindingResource(entry: GpuBindGroupEntry): GPUBindingResource {
  const { resource } = entry;
  if (resource instanceof Buffer) {
    return { buffer: resource.buffer };
  }
  if (resource instanceof Texture && resource.view) {
    return resource.view;
  }
  if (resource instanceof Sampler && resource.sampler) {
    return resource.sampler;
  }
  throw new Error(
    `Binding ${entry.binding}: the resource was not created by the WebGPU backend, or was destroyed`,
  );
}

export class WebGpuPipelineFactory implements GpuPipelineFactory {
  readonly codegen = new WgslCodegen();
  readonly layoutStrategy = wgslLayoutStrategy;

  // Caches by program key, and by layout descriptor.
  private readonly _layouts = new Map<string, PhysicalProgramLayout>();
  private readonly _modules = new Map<string, GPUShaderModule>();
  private readonly _bindGroupLayouts = new Map<string, WebGpuBindGroupLayout>();

  constructor(readonly device: GPUDevice) {}

  resolveLayout(program: CompiledProgram): PhysicalProgramLayout {
    let layout = this._layouts.get(program.programKey);
    if (!layout) {
      layout = this.layoutStrategy.resolve(program.layout);
      this._layouts.set(program.programKey, layout);
    }
    return layout;
  }

  createBindGroupLayout(group: PhysicalBindGroup): WebGpuBindGroupLayout {
    const entries = group.bindings.flatMap(layoutEntries);
    const key = JSON.stringify(entries);
    let layout = this._bindGroupLayouts.get(key);
    if (!layout) {
      layout = new WebGpuBindGroupLayout(
        key,
        this.device.createBindGroupLayout({
          label: `${group.slot} group`,
          entries,
        }),
      );
      this._bindGroupLayouts.set(key, layout);
    }
    return layout;
  }

  createBindGroup(
    layout: GpuBindGroupLayout,
    entries: readonly GpuBindGroupEntry[],
  ): GpuBindGroup {
    if (!(layout instanceof WebGpuBindGroupLayout)) {
      throw new Error(
        'The bind group layout was not created by the WebGPU backend',
      );
    }
    return new WebGpuBindGroup(
      layout,
      this.device.createBindGroup({
        layout: layout.layout,
        entries: entries.flatMap((entry): GPUBindGroupEntry[] =>
          entry.resource instanceof WebGpuObjectTable
            ? [
                {
                  binding: entry.binding,
                  resource: { buffer: entry.resource.rowBuffer },
                },
                {
                  binding: entry.binding + 1,
                  resource: { buffer: entry.resource.instanceBuffer },
                },
              ]
            : [{ binding: entry.binding, resource: bindingResource(entry) }],
        ),
      }),
    );
  }

  createRenderPipeline(
    descriptor: RenderPipelineDescriptor,
  ): GpuRenderPipeline {
    const { gpuDescriptor, vertexBuffers } = this.describe(descriptor);
    return new WebGpuRenderPipeline(
      this.device.createRenderPipeline(gpuDescriptor),
      vertexBuffers,
      descriptor.label,
    );
  }

  async createRenderPipelineAsync(
    descriptor: RenderPipelineDescriptor,
  ): Promise<GpuRenderPipeline> {
    const { gpuDescriptor, vertexBuffers } = this.describe(descriptor);
    return new WebGpuRenderPipeline(
      await this.device.createRenderPipelineAsync(gpuDescriptor),
      vertexBuffers,
      descriptor.label,
    );
  }

  createComputePipeline(
    descriptor: ComputePipelineDescriptor,
  ): WebGpuComputePipeline {
    return new WebGpuComputePipeline(
      this.device.createComputePipeline(this.describeCompute(descriptor)),
      descriptor.label,
    );
  }

  async createComputePipelineAsync(
    descriptor: ComputePipelineDescriptor,
  ): Promise<WebGpuComputePipeline> {
    return new WebGpuComputePipeline(
      await this.device.createComputePipelineAsync(
        this.describeCompute(descriptor),
      ),
      descriptor.label,
    );
  }

  private describeCompute({
    program,
    label,
  }: ComputePipelineDescriptor): GPUComputePipelineDescriptor {
    if (
      !program.module.entryPoints.some((entry) => entry.stage === 'compute')
    ) {
      throw new Error(`Program "${program.name}" has no compute stage`);
    }
    return {
      label: label ?? program.name,
      layout: this.pipelineLayout(program),
      compute: { module: this.shaderModule(program), entryPoint: 'cs_main' },
    };
  }

  private pipelineLayout(program: CompiledProgram): GPUPipelineLayout {
    return this.device.createPipelineLayout({
      bindGroupLayouts: this.resolveLayout(program).groups.map(
        (group) => this.createBindGroupLayout(group).layout,
      ),
    });
  }

  private shaderModule(program: CompiledProgram): GPUShaderModule {
    let module = this._modules.get(program.programKey);
    if (!module) {
      const sources = this.codegen.emit(
        program.module,
        this.resolveLayout(program),
      );
      if (sources.kind !== 'single-module') {
        throw new Error('The WGSL generator must produce a single module');
      }
      module = this.device.createShaderModule({
        label: program.name,
        code: sources.code,
      });
      this._modules.set(program.programKey, module);
    }
    return module;
  }

  private describe(descriptor: RenderPipelineDescriptor): {
    gpuDescriptor: GPURenderPipelineDescriptor;
    vertexBuffers: number[];
  } {
    const { program, primitive, depthStencil, targets } = descriptor;
    const module = this.shaderModule(program);
    const buffers = matchVertexLayout(program.vertexInputs, descriptor.vertex);

    return {
      vertexBuffers: buffers.map((buffer) => buffer.buffer),
      gpuDescriptor: {
        label: descriptor.label ?? program.name,
        layout: this.pipelineLayout(program),
        vertex: {
          module,
          entryPoint: 'vs_main',
          buffers: buffers.map((buffer) => ({
            arrayStride: buffer.stride,
            stepMode: buffer.stepMode,
            attributes: buffer.attributes.map((attribute) => ({
              shaderLocation: attribute.location,
              offset: attribute.offset,
              format: attribute.format,
            })),
          })),
        },
        fragment: {
          module,
          entryPoint: 'fs_main',
          targets: targets.map((target) => ({
            format: target.format as GPUTextureFormat,
            ...(target.blend ? { blend: target.blend } : {}),
          })),
        },
        primitive: {
          topology: primitive.topology,
          cullMode: primitive.cullMode,
          frontFace: primitive.frontFace,
          ...(primitive.topology.endsWith('strip') &&
          descriptor.vertex.indexBuffer
            ? { stripIndexFormat: descriptor.vertex.indexBuffer.format }
            : {}),
        },
        ...(depthStencil
          ? {
              depthStencil: {
                format: depthStencil.format as GPUTextureFormat,
                depthWriteEnabled: depthStencil.depthWrite,
                depthCompare: depthStencil.depthCompare,
                depthBias: depthStencil.depthBias ?? 0,
                depthBiasSlopeScale: depthStencil.depthBiasSlopeScale ?? 0,
              },
            }
          : {}),
        multisample: { count: descriptor.sampleCount ?? 1 },
      },
    };
  }
}
