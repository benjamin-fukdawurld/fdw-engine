import { Engine } from '@fdw/render';

import Scene from './scenegraph/Scene';

export default class App {
  public readonly engine: Engine;

  public scene: Scene;
  private _depthTexture: GPUTexture | null;

  constructor(canvas: HTMLCanvasElement) {
    this.engine = new Engine({ canvas });

    this.scene = new Scene();

    this._depthTexture = null;
  }

  async init(): Promise<void> {
    await this.engine.init();
    await this.scene.init(this.engine);

    this._depthTexture = this.engine.gpu.device.createTexture({
      size: [
        this.engine.surface.canvas.width,
        this.engine.surface.canvas.height,
      ],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  generateRenderPassDescriptor(): GPURenderPassDescriptor {
    return {
      label: 'our basic canvas renderPass',
      colorAttachments: [
        {
          view: this.engine.surface.context.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: this.depthTexture.createView(),
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    };
  }

  render() {
    const encoder = this.engine.gpu.device.createCommandEncoder({
      label: 'command-encoder',
    });

    const pass = encoder.beginRenderPass(this.generateRenderPassDescriptor());
    this.scene.render(this.engine, pass);
    pass.end();

    const commandBuffer = encoder.finish();
    this.engine.gpu.device.queue.submit([commandBuffer]);
  }

  public get depthTexture(): GPUTexture {
    if (
      !this._depthTexture ||
      this._depthTexture.width !== this.engine.surface.canvas.width ||
      this._depthTexture.height !== this.engine.surface.canvas.height
    ) {
      if (this._depthTexture) {
        this._depthTexture.destroy();
      }

      this._depthTexture = this.engine.gpu.device.createTexture({
        size: [
          this.engine.surface.canvas.width,
          this.engine.surface.canvas.height,
        ],
        format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }

    return this._depthTexture;
  }
}
