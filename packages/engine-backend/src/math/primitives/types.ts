export type Vec2 = {
  x: number;
  y: number;
};

export type Vec2Like = Vec2 | [number, number] | Float32Array;

export type Vec3 = Vec2 & {
  z: number;
};

export type Vec3Like = Vec3 | [number, number, number] | Float32Array;

export type Vec4 = Vec3 & {
  w: number;
};

export type Vec4Like = Vec4 | [number, number, number, number] | Float32Array;

export type Quat = {
  x: number;
  y: number;
  z: number;
  w: number;
};

export type QuatLike = Quat | [number, number, number, number] | Float32Array;
