import {
  MaterialDescription,
  MeshDescription,
  Material,
  Mesh,
} from '@fdw/engine-backend';
import { Buffer, WebGpuEngine } from '@fdw/engine-webgpu';

export type BindGroup = {
  index: GPUIndex32;
  bindGroup?: GPUBindGroup;
  dynamicOffsets?: GPUBufferDynamicOffset[];
};

export interface ShaderGenerationStrategy {
  getVertexState(): GPUVertexState;
  getFragmentState(): GPUFragmentState | undefined;
  getPrimitiveState(): GPUPrimitiveState | undefined;
  getDepthStencilState(): GPUDepthStencilState | undefined;
  getBindGroups(): BindGroup[];
}

export interface RenderPipelineBuildStrategy {
  createLayout(strategy: ShaderGenerationStrategy): GPUPipelineLayout;
}

export type topology =
  | 'point-list'
  | 'line-list'
  | 'line-strip'
  | 'triangle-list'
  | 'triangle-strip';
export type cullMode = 'none' | 'front' | 'back';
export type frontFace = 'ccw' | 'cw';

export class RenderPipeline {
  material?: MaterialDescription;
  mesh?: MeshDescription;
  bindGroups: BindGroup[];
  engine: WebGpuEngine;
  pipeline: GPURenderPipeline;
  buildStrategy: RenderPipelineBuildStrategy;
  shaderStrategy: ShaderGenerationStrategy;

  constructor({
    engine,
    material,
    mesh,
    buildStrategy,
    shaderStrategy,
  }: {
    engine: WebGpuEngine;
    material?: MaterialDescription;
    mesh?: MeshDescription;
    buildStrategy: RenderPipelineBuildStrategy;
    shaderStrategy: ShaderGenerationStrategy;
  }) {
    this.engine = engine;
    this.material = material;
    this.mesh = mesh;
    this.buildStrategy = buildStrategy;
    this.shaderStrategy = shaderStrategy;

    this.bindGroups = this.shaderStrategy.getBindGroups();

    this.pipeline = this.engine.device!.createRenderPipeline({
      layout: this.buildStrategy.createLayout(this.shaderStrategy),
      vertex: this.shaderStrategy.getVertexState(),
      fragment: this.shaderStrategy.getFragmentState(),
      primitive: this.shaderStrategy.getPrimitiveState(),
      depthStencil: this.shaderStrategy.getDepthStencilState(),
    });
  }

  render(passEncoder: GPURenderPassEncoder, mesh: Mesh, material: Material) {
    passEncoder.setPipeline(this.pipeline);
    for (let i = 0; i < mesh.vertices.length; i++) {
      const buffer = mesh.vertices[i] as Buffer;
      passEncoder.setVertexBuffer(i, buffer.buffer);
    }
    for (const { index, bindGroup, dynamicOffsets } of this.bindGroups) {
      passEncoder.setBindGroup(index, bindGroup, dynamicOffsets);
    }

    if (!mesh.description.indexBuffer) {
      passEncoder.draw(mesh.description.vertexCount, 1, 0, 0);
      return;
    }

    const buffer = mesh.indices as Buffer;
    passEncoder.setIndexBuffer(
      buffer.buffer,
      mesh.description.indexBuffer.format
    );
    passEncoder.drawIndexed(mesh.description.indexBuffer!.count, 1, 0, 0, 0);
  }
}
