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
