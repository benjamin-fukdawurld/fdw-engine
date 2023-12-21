import { Engine } from '@fdw/render';

import Scene from './scenegraph/Scene';

export default class App {
  public readonly engine: Engine;

  public scene: Scene;

  constructor(canvas: HTMLCanvasElement) {
    this.engine = new Engine({ canvas });

    this.scene = new Scene();
  }

  async init(): Promise<void> {
    await this.engine.init();
    await this.scene.init(this.engine);
  }

  generateRenderPassDescriptor(): GPURenderPassDescriptor {
    return {
      label: 'our basic canvas renderPass',
      colorAttachments: [
        {
          view: this.engine.surface.context.getCurrentTexture().createView(),
          clearValue: [0.3, 0.3, 0.3, 1],
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    };
  }

  render() {
    const renderPassDescriptor = this.generateRenderPassDescriptor();

    const encoder = this.engine.gpu.device.createCommandEncoder({
      label: 'command-encoder',
    });

    const pass = encoder.beginRenderPass(renderPassDescriptor);
    this.scene.render(pass);
    pass.end();

    const commandBuffer = encoder.finish();
    this.engine.gpu.device.queue.submit([commandBuffer]);
  }
}
