import type { GpuRenderTarget, GpuTextureFormat } from '@fdw/engine-backend';

export class WebGpuRenderTarget implements GpuRenderTarget {
  constructor(
    readonly view: GPUTextureView,
    readonly width: number,
    readonly height: number,
    readonly format: GpuTextureFormat,
    // Set when the target owns its texture (offscreen and depth targets).
    readonly texture?: GPUTexture,
  ) {}

  destroy(): void {
    this.texture?.destroy();
  }
}
