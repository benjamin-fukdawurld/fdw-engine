import { IQuat, IVec3 } from './math';
export type { IVec2, IVec3, IVec4, IQuat } from './math';

export type SpatialTransformData = {
  position: IVec3;
  rotation: IQuat;
};

export type TransformData = SpatialTransformData & {
  scale: IVec3;
};

export const MeshAttributeSemanticNames = [
  'position',
  'normal',
  'color',
  'uv',
  'tangent',
  'joints',
  'weights',
] as const;
export type MeshAttributeSemantic =
  | (typeof MeshAttributeSemanticNames)[number]
  | (string & {});

export type VertexFormat = GPUVertexFormat;

export type MeshAttributeDescription = {
  semantic: MeshAttributeSemantic;
  format: VertexFormat;
  offset: number;
};

export type VertexStepMode = GPUVertexStepMode;

export type MeshBufferDescription = {
  stride: number;
  stepMode: VertexStepMode;
  attributes: MeshAttributeDescription[];
};

export type IndexFormat = GPUIndexFormat;

export type MeshDescription = {
  vertexBuffers: MeshBufferDescription[];
  indexBuffer?: {
    format: IndexFormat;
  };
};
