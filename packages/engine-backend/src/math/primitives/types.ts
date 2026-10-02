export type IVec2 = {
  x: number;
  y: number;
};

export type Vec2Like = IVec2 | [number, number] | Float32Array;

export type IVec3 = IVec2 & {
  z: number;
};

export type Vec3Like = IVec3 | [number, number, number] | Float32Array;

export type IVec4 = IVec3 & {
  w: number;
};

export type Vec4Like = IVec4 | [number, number, number, number] | Float32Array;

export type IQuat = {
  x: number;
  y: number;
  z: number;
  w: number;
};

export type QuatLike = IQuat | [number, number, number, number] | Float32Array;

export type RotationOrder = 'xyz' | 'xzy' | 'yxz' | 'yzx' | 'zxy' | 'zyx';

export type Mat2 = Float32Array<ArrayBufferLike>;

// The memory layout of a Mat3 is defined by the backend's math library and
// may hold more than 9 floats (e.g. wgpu-matrix stores 12: 3 columns padded
// to 4 floats). Writers must match the layout of their math library.
export type Mat3 = Float32Array<ArrayBufferLike>;

export type Mat4 = Float32Array<ArrayBufferLike>;

export type IColor = {
  r: number;
  g: number;
  b: number;
  a: number;
};

export type ColorLike =
  | IColor
  | [number, number, number, number]
  | Float32Array;
