import { TransformAdapter } from '@fdw/engine-backend';
import { Transform } from '@fdw/engine-core';
import { Buffer, BufferFactory, transformMath } from '@fdw/engine-webgpu';
import { Material } from './Material';
import { MeshData } from './obj-importer';

export class Mesh {
  readonly vertexBuffer: Buffer;
  readonly numberOfVertices: number;
  readonly indexBuffer?: Buffer;
  readonly numberOfIndices: number;

  readonly material: Material;

  readonly transformAdapter: TransformAdapter;

  constructor(options: {
    data: MeshData;
    material: Material;
    bufferFactory: BufferFactory;
  }) {
    const cubeVertices = new Float32Array(options.data.vertices);
    const cubeIndices = new Uint16Array(options.data.indices);
    this.vertexBuffer = options.bufferFactory.create({
      size: cubeVertices.byteLength,
      usage: ['vertex', 'copy-dst'],
      initialData: cubeVertices,
      label: 'Cube Vertex Data Buffer',
    });

    this.indexBuffer = options.bufferFactory.create({
      size: cubeIndices.byteLength,
      usage: ['index', 'copy-dst'],
      initialData: cubeIndices,
      label: 'Cube Index Data Buffer',
    });
    this.material = options.material;
    this.numberOfVertices = cubeVertices.length / options.data.stride;
    this.numberOfIndices = cubeIndices.length;

    this.transformAdapter = new TransformAdapter({
      transform: new Transform(),
      transformMath,
      bufferFactory: options.bufferFactory,
    });
  }

  get transform(): Transform {
    return this.transformAdapter.transformCache.transform as Transform;
  }
}

export type MeshRenderData = {
  mesh: Mesh;
  material: Material;
  shaderModule: GPUShaderModule;
  pipelineLayout: GPUPipelineLayout;
  // Created on first render, once the surface format is known.
  pipeline?: GPURenderPipeline;
  frameUniformBindGroup: GPUBindGroup;
  objectBindGroup: GPUBindGroup;
  materialBindGroup: GPUBindGroup;
};
