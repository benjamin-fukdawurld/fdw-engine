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

export type SpatialTransformData = {
  position: Vec3;
  rotation: Quat;
};

export type TransformData = SpatialTransformData & {
  scale: Vec3;
};
