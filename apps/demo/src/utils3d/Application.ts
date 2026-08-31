import { BufferFactory, WebGpuEngine, WebGpuSurface } from '@fdw/engine-webgpu';

export class Application {
  readonly canvas: HTMLCanvasElement;
  readonly engine: WebGpuEngine;
  readonly surface: WebGpuSurface;
  readonly bufferFactory: BufferFactory;

  private _depthTexture?: GPUTexture;

  constructor(props: {
    canvas: HTMLCanvasElement;
    engine: WebGpuEngine;
    surface: WebGpuSurface;
  }) {
    this.canvas = props.canvas;
    this.engine = props.engine;
    this.surface = props.surface;
    this.bufferFactory = new BufferFactory(this.engine.device!);
  }

  private get depthTextureDescriptor(): GPUTextureDescriptor {
    return {
      size: [this.surface.width, this.surface.height, 1],
      format: 'depth24plus-stencil8',
      dimension: '2d',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    };
  }

  get depthTexture(): GPUTexture {
    if (!this._depthTexture) {
      this._depthTexture = this.engine.device!.createTexture(
        this.depthTextureDescriptor
      );
    }

    return this._depthTexture!;
  }
}

export default Application;
