import type { GpuSampler, GpuSamplerDescriptor } from '@fdw/engine-backend';

/**
 * WebGPU implementation of {@link GpuSampler}.
 *
 * Wraps a native `GPUSampler` with configurable filtering and addressing modes.
 */
export class WebGpuSampler implements GpuSampler {
  readonly label: string;
  _native: GPUSampler;

  constructor(device: GPUDevice, descriptor: GpuSamplerDescriptor) {
    this.label = descriptor.label ?? '';
    this._native = device.createSampler({
      label: this.label,
      magFilter: descriptor.magFilter ?? 'linear',
      minFilter: descriptor.minFilter ?? 'linear',
      mipmapFilter: descriptor.mipmapFilter ?? 'linear',
      addressModeU: descriptor.addressModeU ?? 'clamp-to-edge',
      addressModeV: descriptor.addressModeV ?? 'clamp-to-edge',
      maxAnisotropy: descriptor.maxAnisotropy ?? 1,
      compare: descriptor.compare as GPUCompareFunction | undefined,
    });
  }
}
