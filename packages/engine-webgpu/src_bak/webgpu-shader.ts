import type {
  GpuShaderModule,
  GpuShaderModuleDescriptor,
} from '@fdw/engine-backend';

/**
 * WebGPU implementation of {@link GpuShaderModule}.
 *
 * Compiles WGSL shader source code into a native `GPUShaderModule`.
 */
export class WebGpuShaderModule implements GpuShaderModule {
  readonly label: string;
  _native: GPUShaderModule;

  constructor(device: GPUDevice, descriptor: GpuShaderModuleDescriptor) {
    this.label = descriptor.label ?? '';
    this._native = device.createShaderModule({
      label: this.label,
      code: descriptor.code,
    });
  }
}
