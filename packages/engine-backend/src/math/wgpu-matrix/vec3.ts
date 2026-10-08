import { Vec3Api as IVec3Api } from '../primitives';
import { vec3 } from 'wgpu-matrix';

export const Vec3Api: IVec3Api = {
  add: (
    a: ArrayLike<number>,
    b: ArrayLike<number>,
    out?: Float32Array
  ): Float32Array => {
    return vec3.add(a, b, out);
  },

  subtract: (
    a: ArrayLike<number>,
    b: ArrayLike<number>,
    out?: Float32Array
  ): Float32Array => {
    return vec3.subtract(a, b, out);
  },

  multiply: (
    a: ArrayLike<number>,
    b: ArrayLike<number>,
    out?: Float32Array
  ): Float32Array => {
    return vec3.multiply(a, b, out);
  },

  divide: (
    a: ArrayLike<number>,
    b: ArrayLike<number>,
    out?: Float32Array
  ): Float32Array => {
    return vec3.divide(a, b, out);
  },

  invert: (a: ArrayLike<number>, out?: Float32Array): Float32Array => {
    return vec3.invert(a, out);
  },

  cross: (
    a: ArrayLike<number>,
    b: ArrayLike<number>,
    out?: Float32Array
  ): Float32Array => {
    return vec3.cross(a, b, out);
  },

  dot: (a: ArrayLike<number>, b: ArrayLike<number>): number => {
    return vec3.dot(a, b);
  },

  negate: (a: ArrayLike<number>, out?: Float32Array): Float32Array => {
    return vec3.negate(a, out);
  },

  multiplyScalar: (
    a: ArrayLike<number>,
    scalar: number,
    out?: Float32Array
  ): Float32Array => {
    return vec3.mulScalar(a, scalar, out);
  },

  divideScalar: (
    a: ArrayLike<number>,
    scalar: number,
    out?: Float32Array
  ): Float32Array => {
    return vec3.divScalar(a, scalar, out);
  },

  multiplyMat3: (
    v: ArrayLike<number>,
    m: ArrayLike<number>,
    out?: Float32Array
  ): Float32Array => {
    return vec3.transformMat3(v, m, out);
  },

  multiplyMat4: (
    v: ArrayLike<number>,
    m: ArrayLike<number>,
    out?: Float32Array
  ): Float32Array => {
    return vec3.transformMat4(v, m, out);
  },

  multiplyQuat: (
    v: ArrayLike<number>,
    q: ArrayLike<number>,
    out?: Float32Array
  ): Float32Array => {
    return vec3.transformQuat(v, q, out);
  },

  angle: (a: ArrayLike<number>, b: ArrayLike<number>): number => {
    return vec3.angle(a, b);
  },

  length: (a: ArrayLike<number>): number => {
    return vec3.length(a);
  },

  lengthSquared: (a: ArrayLike<number>): number => {
    return vec3.lengthSq(a);
  },

  normalize: (a: ArrayLike<number>, out?: Float32Array): Float32Array => {
    return vec3.normalize(a, out);
  },

  distance: (a: ArrayLike<number>, b: ArrayLike<number>): number => {
    return vec3.distance(a, b);
  },

  distanceSquared: (a: ArrayLike<number>, b: ArrayLike<number>): number => {
    return vec3.distanceSq(a, b);
  },

  lerp: (
    a: ArrayLike<number>,
    b: ArrayLike<number>,
    t: number,
    out?: Float32Array
  ): Float32Array => {
    return vec3.lerp(a, b, t, out);
  },

  create(): Float32Array {
    return vec3.create();
  },

  copy: (mat: ArrayLike<number>, out: Float32Array): Float32Array => {
    return vec3.copy(mat, out);
  },

  clone: (mat: ArrayLike<number>): Float32Array => {
    return vec3.clone(mat);
  },

  equals: (
    a: ArrayLike<number>,
    b: ArrayLike<number>,
    epsilon?: number
  ): boolean => {
    epsilon = epsilon ?? 1e-6;
    for (let i = 0; i < 3; i++) {
      if (Math.abs(a[i] - b[i]) >= epsilon) {
        return false;
      }
    }
    return true;
  },

  zero: (out?: Float32Array): Float32Array => {
    return vec3.zero(out);
  },

  one: (out?: Float32Array): Float32Array => {
    out = out ?? vec3.create();
    out[0] = 1;
    out[1] = 1;
    out[2] = 1;
    return out;
  },

  toArray: (mat: ArrayLike<number>, out?: number[]): number[] => {
    out = out ?? new Array(3);
    out[0] = mat[0];
    out[1] = mat[1];
    out[2] = mat[2];
    return out;
  },

  fromArray: (arr: ArrayLike<number>, out?: Float32Array): Float32Array => {
    out = out ?? vec3.create();
    out[0] = arr[0];
    out[1] = arr[1];
    out[2] = arr[2];
    return out;
  },

  isFinite: (mat: ArrayLike<number>): boolean => {
    return (
      Number.isFinite(mat[0]) &&
      Number.isFinite(mat[1]) &&
      Number.isFinite(mat[2])
    );
  },

  isNaN: (mat: ArrayLike<number>): boolean => {
    return Number.isNaN(mat[0]) || Number.isNaN(mat[1]) || Number.isNaN(mat[2]);
  },

  str: (mat: ArrayLike<number>): string => {
    return `Vec3(${mat[0]}, ${mat[1]}, ${mat[2]})`;
  },
};

export default Vec3Api;
