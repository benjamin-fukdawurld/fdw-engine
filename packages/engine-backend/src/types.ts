import { IQuat, IVec3 } from './math';
export type { IVec2, IVec3, IVec4, IQuat } from './math';

export type SpatialTransformData = {
  position: IVec3;
  rotation: IQuat;
};

export type TransformData = SpatialTransformData & {
  scale: IVec3;
};

export const MeshAttributeSemanticNames_ = [
  'position',
  'normal',
  'color',
  'uv',
  'tangent',
  'joints',
  'weights',
] as const;
export type MeshAttributeSemantic_ =
  | (typeof MeshAttributeSemanticNames_)[number]
  | (string & {});

export type VertexFormat_ = GPUVertexFormat;
export type VertexStepMode_ = GPUVertexStepMode;

export type MeshAttributeDescription_ = {
  semantic: MeshAttributeSemantic_;
  format: VertexFormat_;
  offset: number;
};

export type MeshBufferDescription_ = {
  stride: number;
  stepMode: VertexStepMode_;
  attributes: MeshAttributeDescription_[];
};

export type IndexFormat_ = GPUIndexFormat;

export type MeshDescription_ = {
  vertexBuffers: MeshBufferDescription_[];
  indexBuffer?: {
    format: IndexFormat_;
  };
};
