export type Color = {
  r: number;
  g: number;
  b: number;
  a: number;
};

export type Vec2 = {
  x: number;
  y: number;
};

export type Vec3 = Vec2 & {
  z: number;
};

export type Vec4 = Vec3 & {
  w: number;
};

export type Quat = {
  x: number;
  y: number;
  z: number;
  w: number;
};

export type Mat3 = Float32Array<ArrayBufferLike>;

export type Mat4 = Float32Array<ArrayBufferLike>;

export type SpatialTransformData = {
  position: Vec3;
  rotation: Quat;
};

export type TransformData = SpatialTransformData & {
  scale: Vec3;
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
