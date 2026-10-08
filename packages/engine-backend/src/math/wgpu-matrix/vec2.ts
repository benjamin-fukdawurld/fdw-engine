import { Vec2Api as IVec2Api } from '../primitives';
import { vec2 } from 'wgpu-matrix';

export const Vec2Api: IVec2Api = {
  add: (a: Float32Array, b: Float32Array, out?: Float32Array): Float32Array => {
    return vec2.add(a, b, out);
  },

  subtract: (
    a: Float32Array,
    b: Float32Array,
    out?: Float32Array
  ): Float32Array => {
    return vec2.subtract(a, b, out);
  },

  multiply: (
    a: Float32Array,
    b: Float32Array,
    out?: Float32Array
  ): Float32Array => {
    return vec2.multiply(a, b, out);
  },

  divide: (
    a: Float32Array,
    b: Float32Array,
    out?: Float32Array
  ): Float32Array => {
    return vec2.divide(a, b, out);
  },

  invert: (a: Float32Array, out?: Float32Array): Float32Array => {
    return vec2.invert(a, out);
  },

  dot: (a: Float32Array, b: Float32Array): number => {
    return vec2.dot(a, b);
  },

  negate: (a: Float32Array, out?: Float32Array): Float32Array => {
    return vec2.negate(a, out);
  },

  multiplyScalar: (
    a: Float32Array,
    scalar: number,
    out?: Float32Array
  ): Float32Array => {
    return vec2.mulScalar(a, scalar, out);
  },

  divideScalar: (
    a: Float32Array,
    scalar: number,
    out?: Float32Array
  ): Float32Array => {
    return vec2.divScalar(a, scalar, out);
  },

  angle: (a: Float32Array, b: Float32Array): number => {
    return vec2.angle(a, b);
  },

  length: (a: Float32Array): number => {
    return vec2.length(a);
  },

  lengthSquared: (a: Float32Array): number => {
    return vec2.lengthSq(a);
  },

  normalize: (a: Float32Array, out?: Float32Array): Float32Array => {
    return vec2.normalize(a, out);
  },

  distance: (a: Float32Array, b: Float32Array): number => {
    return vec2.distance(a, b);
  },

  distanceSquared: (a: Float32Array, b: Float32Array): number => {
    return vec2.distanceSq(a, b);
  },

  lerp: (
    a: Float32Array,
    b: Float32Array,
    t: number,
    out?: Float32Array
  ): Float32Array => {
    return vec2.lerp(a, b, t, out);
  },

  create(): Float32Array {
    return vec2.create();
  },

  copy: (mat: Float32Array, out: Float32Array): Float32Array => {
    return vec2.copy(mat, out);
  },

  clone: (mat: Float32Array): Float32Array => {
    return vec2.clone(mat);
  },

  equals: (a: Float32Array, b: Float32Array, epsilon?: number): boolean => {
    epsilon = epsilon ?? 1e-6;
    return a.every((value, index) => Math.abs(value - b[index]) < epsilon);
  },

  zero: (out?: Float32Array): Float32Array => {
    return vec2.zero(out);
  },

  one: (out?: Float32Array): Float32Array => {
    out = out ?? vec2.create();
    out[0] = 1;
    out[1] = 1;
    return out;
  },

  toArray: (mat: Float32Array, out?: number[]): number[] => {
    out = out ?? new Array(2);
    out[0] = mat[0];
    out[1] = mat[1];
    return out;
  },

  fromArray: (arr: number[], out?: Float32Array): Float32Array => {
    out = out ?? vec2.create();
    out[0] = arr[0];
    out[1] = arr[1];
    return out;
  },

  isFinite: (mat: Float32Array): boolean => {
    return Number.isFinite(mat[0]) && Number.isFinite(mat[1]);
  },

  isNaN: (mat: Float32Array): boolean => {
    return Number.isNaN(mat[0]) || Number.isNaN(mat[1]);
  },

  str: (mat: Float32Array): string => {
    return `Vec2(${mat[0]}, ${mat[1]})`;
  },
};

export default Vec2Api;
