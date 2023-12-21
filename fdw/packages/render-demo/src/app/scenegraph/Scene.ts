import { Engine } from '@fdw/render';

import { mat4 } from 'gl-matrix';
import Camera from './Camera';
import Material from './Material';

function createFVertices() {
  const vertexData = new Float32Array([
    // left column
    0, 0, 30, 0, 0, 150, 30, 150,

    // top rung
    30, 0, 100, 0, 30, 30, 100, 30,

    // middle rung
    30, 60, 70, 60, 30, 90, 70, 90,
  ]);

  const indexData = new Uint32Array([
    0,
    1,
    2,
    2,
    1,
    3, // left column
    4,
    5,
    6,
    6,
    5,
    7, // top run
    8,
    9,
    10,
    10,
    9,
    11, // middle run
  ]);

  return {
    vertexData,
    indexData,
    numVertices: indexData.length,
  };
}

export class Scene {
  public worldMatrix: mat4;
  public camera: Camera;
  public material: Material;

  constructor() {
    this.worldMatrix = mat4.identity(new Float32Array(16));
    this.camera = new Camera();
    this.material = new Material();

    mat4.scale(this.worldMatrix, this.worldMatrix, [1 / 4, 1 / 4, 1 / 4]);
  }

  async init(engine: Engine) {
    const screen = this.camera.screen;
    screen.width = engine.surface.canvas.offsetWidth;
    screen.height = engine.surface.canvas.offsetHeight;

    await this.material.init(engine);
    const uniformBufferSize = 4 * 3 * 16; //sizeof(float) * 3 * mat4x4f
    const uniformValues = new Float32Array(uniformBufferSize / 4);
    uniformValues.set(this.worldMatrix, 0);

    uniformValues.set(this.camera.viewMatrix, 16);
    uniformValues.set(this.camera.projectionMatrix, 32);

    engine.gpu.device.queue.writeBuffer(
      this.material.matBuffer,
      0,
      uniformValues
    );
  }

  render(pass: GPURenderPassEncoder) {
    pass.setPipeline(this.material.program.pipeline);
    pass.setBindGroup(0, this.material.bindGroup);
    pass.draw(6); // call our vertex shader 3 times for each instance
  }
}

export default Scene;
