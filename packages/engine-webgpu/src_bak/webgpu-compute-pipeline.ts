import type {
  GpuComputePipeline,
  GpuComputePipelineDescriptor,
} from '@fdw/engine-backend';
import type { WebGpuShaderModule } from './webgpu-shader';
import type { WebGpuBindGroupLayout } from './webgpu-bind-group';

/**
 * WebGPU implementation of {@link GpuComputePipeline}.
 *
 * Translates the abstract compute pipeline descriptor into a native `GPUComputePipeline`.
 */
export class WebGpuComputePipeline implements GpuComputePipeline {
  readonly label: string;
  _native: GPUComputePipeline;

  constructor(device: GPUDevice, descriptor: GpuComputePipelineDescriptor) {
    this.label = descriptor.label ?? '';

    const computeModule = (descriptor.compute.module as WebGpuShaderModule)
      ._native;

    const pipelineLayout = descriptor.layout
      ? device.createPipelineLayout({
          bindGroupLayouts: descriptor.layout.map(
            (l) => (l as WebGpuBindGroupLayout)._native,
          ),
        })
      : 'auto';

    this._native = device.createComputePipeline({
      label: this.label,
      layout: pipelineLayout,
      compute: {
        module: computeModule,
        entryPoint: descriptor.compute.entryPoint,
      },
    });
  }
}
