import { Vec4Api as IVec4Api } from '@fdw/engine-backend';
import { vec4 } from 'wgpu-matrix';

export const Vec4Api: IVec4Api = {
  add: (a: Float32Array, b: Float32Array, out?: Float32Array): Float32Array => {
    return vec4.add(a, b, out);
  },

  subtract: (
    a: Float32Array,
    b: Float32Array,
    out?: Float32Array
  ): Float32Array => {
    return vec4.subtract(a, b, out);
  },

  multiply: (
    a: Float32Array,
    b: Float32Array,
    out?: Float32Array
  ): Float32Array => {
    return vec4.multiply(a, b, out);
  },

  divide: (
    a: Float32Array,
    b: Float32Array,
    out?: Float32Array
  ): Float32Array => {
    return vec4.divide(a, b, out);
  },

  invert: (a: Float32Array, out?: Float32Array): Float32Array => {
    return vec4.invert(a, out);
  },

  dot: (a: Float32Array, b: Float32Array): number => {
    return vec4.dot(a, b);
  },

  negate: (a: Float32Array, out?: Float32Array): Float32Array => {
    return vec4.negate(a, out);
  },

  multiplyScalar: (
    a: Float32Array,
    scalar: number,
    out?: Float32Array
  ): Float32Array => {
    return vec4.mulScalar(a, scalar, out);
  },

  divideScalar: (
    a: Float32Array,
    scalar: number,
    out?: Float32Array
  ): Float32Array => {
    return vec4.divScalar(a, scalar, out);
  },

  multiplyMat4: (
    v: Float32Array,
    m: Float32Array,
    out?: Float32Array
  ): Float32Array => {
    return vec4.transformMat4(v, m, out);
  },

  length: (a: Float32Array): number => {
    return vec4.length(a);
  },

  lengthSquared: (a: Float32Array): number => {
    return vec4.lengthSq(a);
  },

  normalize: (a: Float32Array, out?: Float32Array): Float32Array => {
    return vec4.normalize(a, out);
  },

  distance: (a: Float32Array, b: Float32Array): number => {
    return vec4.distance(a, b);
  },

  distanceSquared: (a: Float32Array, b: Float32Array): number => {
    return vec4.distanceSq(a, b);
  },

  lerp: (
    a: Float32Array,
    b: Float32Array,
    t: number,
    out?: Float32Array
  ): Float32Array => {
    return vec4.lerp(a, b, t, out);
  },

  create(): Float32Array {
    return vec4.create();
  },

  copy: (mat: Float32Array, out: Float32Array): Float32Array => {
    return vec4.copy(mat, out);
  },

  clone: (mat: Float32Array): Float32Array => {
    return vec4.clone(mat);
  },

  equals: (a: Float32Array, b: Float32Array, epsilon?: number): boolean => {
    epsilon = epsilon ?? 1e-6;
    return a.every((value, index) => Math.abs(value - b[index]) < epsilon);
  },

  zero: (out?: Float32Array): Float32Array => {
    return vec4.zero(out);
  },

  one: (out?: Float32Array): Float32Array => {
    out = out ?? vec4.create();
    out[0] = 1;
    out[1] = 1;
    out[2] = 1;
    return out;
  },

  toArray: (mat: Float32Array, out?: number[]): number[] => {
    out = out ?? new Array(3);
    out[0] = mat[0];
    out[1] = mat[1];
    out[2] = mat[2];
    return out;
  },

  fromArray: (arr: number[], out?: Float32Array): Float32Array => {
    out = out ?? vec4.create();
    out[0] = arr[0];
    out[1] = arr[1];
    out[2] = arr[2];
    return out;
  },

  isFinite: (mat: Float32Array): boolean => {
    return (
      Number.isFinite(mat[0]) &&
      Number.isFinite(mat[1]) &&
      Number.isFinite(mat[2])
    );
  },

  isNaN: (mat: Float32Array): boolean => {
    return Number.isNaN(mat[0]) || Number.isNaN(mat[1]) || Number.isNaN(mat[2]);
  },

  str: (mat: Float32Array): string => {
    return `Vec4(${mat[0]}, ${mat[1]}, ${mat[2]})`;
  },
};

export default Vec4Api;
