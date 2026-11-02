import { Engine, GpuTextureFormat, IColor, Surface } from '@fdw/engine-backend';
import WebGpuEngine from './WebGpuEngine';
import { WebGpuRenderTarget } from './render/WebGpuRenderTarget';

export type WebGpuSurfaceConfig = {
  alphaMode?: 'premultiplied' | 'opaque';
  clearColor?: IColor;
};

export class WebGpuSurface implements Surface {
  readonly config: WebGpuSurfaceConfig;
  context: GPUCanvasContext;
  textureFormat?: GPUTextureFormat;
  // The view of the current texture, created once per texture.
  private _texture?: GPUTexture;
  private _view?: GPUTextureView;

  constructor(canvas: HTMLCanvasElement, config: WebGpuSurfaceConfig = {}) {
    const context = canvas.getContext('webgpu');
    if (!context) {
      throw new Error('WebGPU is not supported in this browser');
    }
    this.context = context;
    this.config = config;
  }

  async init(engine: Engine): Promise<void> {
    if (!(engine instanceof WebGpuEngine)) {
      throw new Error('Engine must be a WebGpuEngine');
    }

    // A paused engine keeps its device.
    const device = engine.device;
    if (
      (engine.state.value !== 'ready' && engine.state.value !== 'paused') ||
      !device
    ) {
      throw new Error(
        'Engine must be in ready or paused state to initialize surface',
      );
    }

    // The format of the entry point of the engine (Dawn outside a browser).
    this.textureFormat = engine.gpu?.getPreferredCanvasFormat() ?? 'bgra8unorm';
    this.context.configure({
      device,
      format: this.textureFormat,
      alphaMode: this.config.alphaMode ?? 'premultiplied',
    });
  }

  get width() {
    return this.context.canvas.width;
  }

  set width(value: number) {
    this.context.canvas.width = value;
  }

  get height() {
    return this.context.canvas.height;
  }

  set height(value: number) {
    this.context.canvas.height = value;
  }

  get format(): GpuTextureFormat {
    if (!this.textureFormat) {
      throw new Error('The surface is not initialized');
    }
    return this.textureFormat;
  }

  getCurrentTarget(): WebGpuRenderTarget {
    const texture = this.context.getCurrentTexture();
    return new WebGpuRenderTarget(
      this.viewOf(texture),
      texture.width,
      texture.height,
      this.format,
    );
  }

  // The canvas is presented when the browser composites the page.
  present(): void {
    return;
  }

  get textureView(): GPUTextureView {
    return this.viewOf(this.context.getCurrentTexture());
  }

  // The context returns the same texture until the frame is presented.
  private viewOf(texture: GPUTexture): GPUTextureView {
    if (this._texture !== texture || !this._view) {
      this._texture = texture;
      this._view = texture.createView();
    }
    return this._view;
  }

  get colorAttachment(): GPURenderPassColorAttachment {
    return {
      view: this.textureView,
      loadOp: 'clear' as const,
      storeOp: 'store' as const,
      clearValue: this.config.clearColor ?? { r: 0, g: 0, b: 0, a: 1 },
    };
  }
}

export default WebGpuSurface;
