import { Engine, GpuTextureFormat, Surface } from '@fdw/engine-backend';
import { GL } from './gl';
import { WebGl2RenderTarget } from './render/WebGl2RenderTarget';
import WebGl2Engine from './WebGl2Engine';

// A surface presenting to a canvas. Frames are rendered to a framebuffer of
// the size of the canvas, then copied to the drawing buffer of the context
// on present(). When the context belongs to another canvas (the offscreen
// canvas of the engine), its image is then transferred to this one.
export class WebGl2CanvasSurface implements Surface {
  readonly format: GpuTextureFormat = 'rgba8unorm';
  private _engine?: WebGl2Engine;
  private _bitmap?: ImageBitmapRenderingContext;
  private _target?: WebGl2RenderTarget;

  constructor(readonly canvas: HTMLCanvasElement) {}

  async init(engine: Engine): Promise<void> {
    if (!(engine instanceof WebGl2Engine)) {
      throw new Error('Engine must be a WebGl2Engine');
    }
    if (engine.state.value !== 'ready' || !engine.gl) {
      throw new Error('Engine must be in ready state to initialize surface');
    }
    this._engine = engine;
    if (engine.canvas !== this.canvas) {
      const bitmap = this.canvas.getContext('bitmaprenderer');
      if (!bitmap) {
        throw new Error('The canvas cannot display images');
      }
      this._bitmap = bitmap;
    }
  }

  get width(): number {
    return this.canvas.width;
  }

  set width(value: number) {
    this.canvas.width = value;
  }

  get height(): number {
    return this.canvas.height;
  }

  set height(value: number) {
    this.canvas.height = value;
  }

  getCurrentTarget(): WebGl2RenderTarget {
    const gl = this._engine?.gl;
    if (!gl) {
      throw new Error('The surface is not initialized');
    }
    if (
      !this._target ||
      this._target.width !== this.width ||
      this._target.height !== this.height
    ) {
      this._target?.destroy();
      this._target = new WebGl2RenderTarget(
        gl,
        this.width,
        this.height,
        this.format,
        'canvas surface',
      );
    }
    return this._target;
  }

  present(): void {
    const engine = this._engine;
    const gl = engine?.gl;
    const target = this._target;
    if (!engine || !gl || !target) {
      return;
    }
    const { width, height } = target;
    const canvas = engine.canvas as HTMLCanvasElement | OffscreenCanvas;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.bindFramebuffer(GL.READ_FRAMEBUFFER, target.framebuffer());
    gl.bindFramebuffer(GL.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(
      0,
      0,
      width,
      height,
      0,
      0,
      width,
      height,
      GL.COLOR_BUFFER_BIT,
      GL.NEAREST,
    );
    if (this._bitmap && 'transferToImageBitmap' in canvas) {
      this._bitmap.transferFromImageBitmap(canvas.transferToImageBitmap());
    }
  }

  destroy(): void {
    this._target?.destroy();
    this._target = undefined;
  }
}

export default WebGl2CanvasSurface;
