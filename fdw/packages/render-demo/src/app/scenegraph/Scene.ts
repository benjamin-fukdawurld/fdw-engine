import { Engine } from '@fdw/render';

import { mat4, vec3 } from 'wgpu-matrix';
import Camera from './Camera';
import Material from './Material';

export function createFVertices() {
  const positions = [
    // left column
    0, 0, 0, 30, 0, 0, 0, 150, 0, 30, 150, 0,

    // top rung
    30, 0, 0, 100, 0, 0, 30, 30, 0, 100, 30, 0,

    // middle rung
    30, 60, 0, 70, 60, 0, 30, 90, 0, 70, 90, 0,

    // left column back
    0, 0, 30, 30, 0, 30, 0, 150, 30, 30, 150, 30,

    // top rung back
    30, 0, 30, 100, 0, 30, 30, 30, 30, 100, 30, 30,

    // middle rung back
    30, 60, 30, 70, 60, 30, 30, 90, 30, 70, 90, 30,
  ];

  const indices = [
    // front
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

    // back
    12,
    14,
    13,
    14,
    15,
    13, // left column back
    16,
    18,
    17,
    18,
    19,
    17, // top run back
    20,
    22,
    21,
    22,
    23,
    21, // middle run back

    0,
    12,
    5,
    12,
    17,
    5, // top
    5,
    17,
    7,
    17,
    19,
    7, // top rung right
    6,
    7,
    18,
    18,
    7,
    19, // top rung bottom
    6,
    18,
    8,
    18,
    20,
    8, // between top and middle rung
    8,
    20,
    9,
    20,
    21,
    9, // middle rung top
    9,
    21,
    11,
    21,
    23,
    11, // middle rung right
    10,
    11,
    22,
    22,
    11,
    23, // middle rung bottom
    10,
    22,
    3,
    22,
    15,
    3, // stem right
    2,
    3,
    14,
    14,
    3,
    15, // bottom
    0,
    2,
    12,
    12,
    2,
    14, // left
  ];

  const quadColors = [
    200,
    70,
    120, // left column front
    200,
    70,
    120, // top rung front
    200,
    70,
    120, // middle rung front

    80,
    70,
    200, // left column back
    80,
    70,
    200, // top rung back
    80,
    70,
    200, // middle rung back

    70,
    200,
    210, // top
    160,
    160,
    220, // top rung right
    90,
    130,
    110, // top rung bottom
    200,
    200,
    70, // between top and middle rung
    210,
    100,
    70, // middle rung top
    210,
    160,
    70, // middle rung right
    70,
    180,
    210, // middle rung bottom
    100,
    70,
    210, // stem right
    76,
    210,
    100, // bottom
    140,
    210,
    80, // left
  ];

  const numVertices = indices.length;
  const vertexData = new Float32Array(numVertices * 4); // xyz + color
  const colorData = new Uint8Array(vertexData.buffer);

  for (let i = 0; i < indices.length; ++i) {
    const positionNdx = indices[i] * 3;
    const position = positions.slice(positionNdx, positionNdx + 3);
    vertexData.set(position, i * 4);

    const quadNdx = ((i / 6) | 0) * 3;
    const color = quadColors.slice(quadNdx, quadNdx + 3);
    colorData.set(color, i * 16 + 12);
    colorData[i * 16 + 15] = 255;
  }

  return {
    vertexData,
    numVertices,
  };
}

export function createMesh() {
  const position = [
    -0.5,
    -0.5,
    0.5, // 0
    0.5,
    -0.5,
    0.5, // 1
    -0.5,
    0.5,
    0.5, // 2
    -0.5, 
    0.5,
    0.5, // 2
    0.5,
    -0.5,
    0.5, // 1
    0.5,
    0.5,
    0.5, // 3
  ];

  const vertexData = new Float32Array(4 * 6);
  const colorData = new Uint8Array(vertexData.buffer);

  for (let i = 0; i < 6; ++i) {
    const fOffset = i * 4;
    const iOffset = i * 16 + 12;
    const posOffset = i * 3;

    vertexData.set(
      [position[posOffset], position[posOffset + 1], position[posOffset + 2]],
      fOffset
    );
    colorData.set([255, 0, 0, 255], iOffset);
  }

  return {
    vertexData,
    numVertices: 6,
  };
}

export class Scene {
  public worldMatrix: Float32Array;
  public camera: Camera;
  public material: Material;
  public vertexBuffer: GPUBuffer | null;
  public indexBuffer: GPUBuffer | null;
  public numVertices: number;

  constructor() {
    this.worldMatrix = mat4.create();
    mat4.scale(this.worldMatrix, this.worldMatrix, [1, 1, 1]);

    this.camera = new Camera();
    this.material = new Material();

    this.camera.position = vec3.create(0, 0, 3);

    this.vertexBuffer = null;
    this.indexBuffer = null;
    this.numVertices = 0;
  }

  async init(engine: Engine) {
    const screen = this.camera.screen;
    screen.width = engine.surface.canvas.clientWidth;
    screen.height = engine.surface.canvas.clientHeight;

    await this.material.init(engine);
    engine.gpu.device.queue.writeBuffer(
      this.material.uniformBuffer,
      0,
      this.material.uniformValues
    );

    const { vertexData, numVertices } = createMesh();
    this.numVertices = numVertices;
    this.vertexBuffer = engine.gpu.device.createBuffer({
      label: 'vertex buffer vertices',
      size: vertexData.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    engine.gpu.device.queue.writeBuffer(this.vertexBuffer, 0, vertexData);
  }

  render(engine: Engine, pass: GPURenderPassEncoder) {
    pass.setPipeline(this.material.program.pipeline);
    pass.setVertexBuffer(0, this.vertexBuffer);

    this.material.setModelValue(this.worldMatrix);
    this.material.setProjectionValue(this.camera.projectionMatrix);
    this.material.setCameraValue(this.camera.viewMatrix);

    // upload the uniform values to the uniform buffer
    engine.gpu.device.queue.writeBuffer(
      this.material.uniformBuffer,
      0,
      this.material.uniformValues
    );

    pass.setBindGroup(0, this.material.bindGroup);
    pass.draw(this.numVertices);
  }
}

export default Scene;
