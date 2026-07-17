import type {
  GpuRenderPipeline,
  GpuRenderPipelineDescriptor,
} from '@fdw/engine-backend';
import type { WebGpuShaderModule } from './webgpu-shader';
import type { WebGpuBindGroupLayout } from './webgpu-bind-group';

/**
 * WebGPU implementation of {@link GpuRenderPipeline}.
 *
 * Translates the abstract pipeline descriptor into a native `GPURenderPipeline`,
 * mapping vertex layouts, fragment targets, primitive topology, and depth-stencil state.
 */
export class WebGpuRenderPipeline implements GpuRenderPipeline {
  readonly label: string;
  _native: GPURenderPipeline;

  constructor(device: GPUDevice, descriptor: GpuRenderPipelineDescriptor) {
    this.label = descriptor.label ?? '';

    const vertexModule = (descriptor.vertex.module as WebGpuShaderModule)
      ._native;
    const fragmentModule = (descriptor.fragment.module as WebGpuShaderModule)
      ._native;

    const pipelineLayout = descriptor.layout
      ? device.createPipelineLayout({
          bindGroupLayouts: descriptor.layout.map(
            (l) => (l as WebGpuBindGroupLayout)._native,
          ),
        })
      : 'auto';

    this._native = device.createRenderPipeline({
      label: this.label,
      layout: pipelineLayout,
      vertex: {
        module: vertexModule,
        entryPoint: descriptor.vertex.entryPoint,
        buffers: descriptor.vertex.buffers.map((b) => ({
          arrayStride: b.arrayStride,
          stepMode: b.stepMode ?? 'vertex',
          attributes: b.attributes.map((a) => ({
            format: a.format as GPUVertexFormat,
            offset: a.offset,
            shaderLocation: a.shaderLocation,
          })),
        })),
      },
      fragment: {
        module: fragmentModule,
        entryPoint: descriptor.fragment.entryPoint,
        targets: descriptor.fragment.targets.map((t) => ({
          format: t.format as unknown as GPUTextureFormat,
          blend: t.blend as GPUBlendState | undefined,
          writeMask: t.writeMask,
        })),
      },
      primitive: {
        topology: (descriptor.primitive?.topology ??
          'triangle-list') as GPUPrimitiveTopology,
        cullMode: (descriptor.primitive?.cullMode ?? 'back') as GPUCullMode,
        frontFace: (descriptor.primitive?.frontFace ?? 'ccw') as GPUFrontFace,
      },
      depthStencil: descriptor.depthStencil
        ? {
            format: descriptor.depthStencil
              .format as unknown as GPUTextureFormat,
            depthWriteEnabled: descriptor.depthStencil.depthWriteEnabled,
            depthCompare: descriptor.depthStencil
              .depthCompare as GPUCompareFunction,
          }
        : undefined,
    });
  }
}
