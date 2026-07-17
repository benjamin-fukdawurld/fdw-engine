/**
 * GPU Render Pipeline abstraction
 */

import { GpuShaderModule } from './shader';
import type { TextureFormat } from './texture';

export type PrimitiveTopology =
  | 'point-list'
  | 'line-list'
  | 'line-strip'
  | 'triangle-list'
  | 'triangle-strip';

export type CullMode = 'none' | 'front' | 'back';

export type FrontFace = 'ccw' | 'cw';

export type CompareFunction =
  | 'never'
  | 'less'
  | 'equal'
  | 'less-equal'
  | 'greater'
  | 'not-equal'
  | 'greater-equal'
  | 'always';

export type VertexFormat =
  | 'float32'
  | 'float32x2'
  | 'float32x3'
  | 'float32x4'
  | 'uint32'
  | 'uint32x2'
  | 'uint32x3'
  | 'uint32x4'
  | 'sint32'
  | 'sint32x2'
  | 'sint32x3'
  | 'sint32x4'
  | 'uint8x4'
  | 'unorm8x4';

export interface VertexAttribute {
  format: VertexFormat;
  offset: number;
  shaderLocation: number;
}

export interface VertexBufferLayout {
  arrayStride: number;
  stepMode?: 'vertex' | 'instance';
  attributes: VertexAttribute[];
}

export interface DepthStencilState {
  format: TextureFormat;
  depthWriteEnabled: boolean;
  depthCompare: CompareFunction;
}

export interface BlendState {
  color: {
    srcFactor: string;
    dstFactor: string;
    operation: string;
  };
  alpha: {
    srcFactor: string;
    dstFactor: string;
    operation: string;
  };
}

export interface ColorTargetState {
  format: TextureFormat;
  blend?: BlendState;
  writeMask?: number;
}

export interface GpuRenderPipelineDescriptor {
  label?: string;
  vertex: {
    module: GpuShaderModule;
    entryPoint: string;
    buffers: VertexBufferLayout[];
  };
  fragment: {
    module: GpuShaderModule;
    entryPoint: string;
    targets: ColorTargetState[];
  };
  primitive?: {
    topology?: PrimitiveTopology;
    cullMode?: CullMode;
    frontFace?: FrontFace;
  };
  depthStencil?: DepthStencilState;
  layout?: import('./bind-group').GpuBindGroupLayout[];
}

export interface GpuRenderPipeline {
  readonly label: string;
}
