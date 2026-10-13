import { Engine, GpuTextureFormat, Surface } from '@fdw/engine-backend';
import { readAttachment } from './gpu/readback';
import { WebGl2RenderTarget } from './render/WebGl2RenderTarget';
import WebGl2Engine from './WebGl2Engine';

// A surface rendering into a texture: for render-to-texture, screenshots and
// headless tests.
export class WebGl2OffscreenSurface implements Surface {
  readonly format: GpuTextureFormat;
  private _width: number;
  private _height: number;
  private _gl?: WebGL2RenderingContext;
  private _target?: WebGl2RenderTarget;

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
    if (!(engine instanceof WebGl2Engine) || !engine.gl) {
      throw new Error('The surface needs a ready WebGl2Engine');
    }
    this._gl = engine.gl;
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

  getCurrentTarget(): WebGl2RenderTarget {
    if (!this._gl) {
      throw new Error('The surface is not initialized');
    }
    this._target ??= new WebGl2RenderTarget(
      this._gl,
      this._width,
      this._height,
      this.format,
      'offscreen surface'
    );
    return this._target;
  }

  present(): void {
    return;
  }

  // Reads back the pixels of the last frame, row by row from the top, as
  // the WebGPU surface. Only for 4-byte formats (rgba8unorm…).
  async readPixels(): Promise<Uint8Array> {
    const gl = this._gl;
    const target = this._target;
    if (!gl || !target) {
      throw new Error('Nothing has been rendered to the surface');
    }
    return new Uint8Array(
      await readAttachment(gl, target, {
        x: 0,
        y: 0,
        width: this._width,
        height: this._height,
      })
    );
  }

  destroy(): void {
    this.release();
    this._gl = undefined;
  }

  private release(): void {
    this._target?.destroy();
    this._target = undefined;
  }
}

export default WebGl2OffscreenSurface;
