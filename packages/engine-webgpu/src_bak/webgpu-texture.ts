import type {
  GpuTexture,
  GpuTextureDescriptor,
  TextureFormat,
} from '@fdw/engine-backend';

/**
 * WebGPU implementation of {@link GpuTexture}.
 *
 * Wraps a native `GPUTexture` and exposes view creation and destruction.
 */
export class WebGpuTexture implements GpuTexture {
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly format: TextureFormat;

  _native: GPUTexture;

  constructor(device: GPUDevice, descriptor: GpuTextureDescriptor) {
    this.label = descriptor.label ?? '';
    this.width = descriptor.width;
    this.height = descriptor.height;
    this.format = descriptor.format;

    this._native = device.createTexture({
      label: this.label,
      size: {
        width: descriptor.width,
        height: descriptor.height,
        depthOrArrayLayers: descriptor.depth ?? 1,
      },
      mipLevelCount: descriptor.mipLevelCount ?? 1,
      format: descriptor.format as GPUTextureFormat,
      usage: descriptor.usage,
    });
  }

  /** Creates a default view of this texture. */
  createView(): GPUTextureView {
    return this._native.createView();
  }

  /** Destroys the underlying GPU texture. */
  destroy(): void {
    this._native.destroy();
  }
}
