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

    if (engine.state.value !== 'ready') {
      throw new Error('Engine must be in ready state to initialize surface');
    }

    const device = engine.device!;
    this.textureFormat = navigator.gpu.getPreferredCanvasFormat();
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
      texture.createView(),
      texture.width,
      texture.height,
      this.format
    );
  }

  // The canvas is presented when the browser composites the page.
  present(): void {
    return;
  }

  get textureView() {
    return this.context.getCurrentTexture().createView();
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
