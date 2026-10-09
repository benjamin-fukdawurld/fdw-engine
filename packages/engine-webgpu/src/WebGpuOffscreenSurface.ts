import { Engine, GpuTextureFormat, Surface } from '@fdw/engine-backend';
import WebGpuEngine from './WebGpuEngine';
import { WebGpuRenderTarget } from './render/WebGpuRenderTarget';

// A surface rendering into a texture: for render-to-texture, screenshots and
// headless tests.
export class WebGpuOffscreenSurface implements Surface {
  readonly format: GpuTextureFormat;
  private _width: number;
  private _height: number;
  private _device?: GPUDevice;
  private _target?: WebGpuRenderTarget;

  constructor(
    width: number,
    height: number,
    format: GpuTextureFormat = 'rgba8unorm'
  ) {
    this._width = width;
    this._height = height;
    this.format = format;
  }

  async init(engine: Engine): Promise<void> {
    if (!(engine instanceof WebGpuEngine) || !engine.device) {
      throw new Error('The surface needs a ready WebGpuEngine');
    }
    this._device = engine.device;
  }

  get width(): number {
    return this._width;
  }

  set width(value: number) {
    this._width = value;
    this.release();
  }

  get height(): number {
    return this._height;
  }

  set height(value: number) {
    this._height = value;
    this.release();
  }

  getCurrentTarget(): WebGpuRenderTarget {
    if (!this._device) {
      throw new Error('The surface is not initialized');
    }
    if (!this._target) {
      const texture = this._device.createTexture({
        label: 'offscreen surface',
        size: [this._width, this._height],
        format: this.format as GPUTextureFormat,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.COPY_DST,
      });
      this._target = new WebGpuRenderTarget(
        texture.createView(),
        this._width,
        this._height,
        this.format,
        texture
      );
    }
    return this._target;
  }

  present(): void {
    return;
  }

  // Reads back the pixels of the last frame, row by row, without padding.
  // Only for 4-byte formats (rgba8unorm, bgra8unorm…).
  async readPixels(): Promise<Uint8Array> {
    const device = this._device;
    const texture = this._target?.texture;
    if (!device || !texture) {
      throw new Error('Nothing has been rendered to the surface');
    }
    const rowBytes = this._width * 4;
    // Copies need rows aligned to 256 bytes.
    const paddedRowBytes = Math.ceil(rowBytes / 256) * 256;
    const buffer = device.createBuffer({
      size: paddedRowBytes * this._height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture },
      { buffer, bytesPerRow: paddedRowBytes },
      [this._width, this._height]
    );
    device.queue.submit([encoder.finish()]);

    await buffer.mapAsync(GPUMapMode.READ);
    const padded = new Uint8Array(buffer.getMappedRange());
    const pixels = new Uint8Array(rowBytes * this._height);
    for (let row = 0; row < this._height; row++) {
      pixels.set(
        padded.subarray(row * paddedRowBytes, row * paddedRowBytes + rowBytes),
        row * rowBytes
      );
    }
    buffer.unmap();
    buffer.destroy();
    return pixels;
  }

  destroy(): void {
    this.release();
    this._device = undefined;
  }

  private release(): void {
    this._target?.destroy();
    this._target = undefined;
  }
}

export default WebGpuOffscreenSurface;
