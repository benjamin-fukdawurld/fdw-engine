import { Engine, GpuTextureFormat, Surface } from '@fdw/engine-backend';
import WebGpuEngine from './WebGpuEngine';
import { readTextureRegion } from './gpu/readback';
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
    format: GpuTextureFormat = 'rgba8unorm',
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
        texture,
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
    return new Uint8Array(
      await readTextureRegion(
        device,
        texture,
        { x: 0, y: 0, width: this._width, height: this._height },
        4,
      ),
    );
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
