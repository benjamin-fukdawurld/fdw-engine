import type { Mat3Api as IMat3Api } from '../primitives';
import { mat3 } from 'wgpu-matrix';

export const Mat3Api: IMat3Api = {
  identity: (out?: Float32Array): Float32Array => {
    return mat3.identity(out);
  },

  premultiply: (
    a: ArrayLike<number>,
    b: ArrayLike<number>,
    out?: Float32Array
  ): Float32Array => {
    return mat3.multiply(b, a, out);
  },

  multiply: (
    a: ArrayLike<number>,
    b: ArrayLike<number>,
    out?: Float32Array
  ): Float32Array => {
    return mat3.multiply(a, b, out);
  },

  invert: (a: ArrayLike<number>, out?: Float32Array): Float32Array => {
    return mat3.invert(a, out);
  },

  transpose: (a: ArrayLike<number>, out?: Float32Array): Float32Array => {
    return mat3.transpose(a, out);
  },

  negate: (a: ArrayLike<number>, out?: Float32Array): Float32Array => {
    return mat3.negate(a, out);
  },
  multiplyScalar: (
    a: ArrayLike<number>,
    scalar: number,
    out?: Float32Array
  ): Float32Array => {
    return mat3.multiplyScalar(a, scalar, out);
  },
  add: (
    a: ArrayLike<number>,
    b: ArrayLike<number>,
    out?: Float32Array
  ): Float32Array => {
    return mat3.add(a, b, out);
  },

  determinant: (mat: ArrayLike<number>): number => {
    return mat3.determinant(mat);
  },

  fromMat4: (m: ArrayLike<number>, out?: Float32Array): Float32Array => {
    out = out ?? mat3.create();
    mat3.fromMat4(m, out);
    return out;
  },

  create: (): Float32Array => {
    return mat3.create();
  },

  copy: (mat: ArrayLike<number>, out: Float32Array): Float32Array => {
    return mat3.copy(mat, out);
  },

  clone: (mat: ArrayLike<number>): Float32Array => {
    return mat3.clone(mat);
  },

  equals: (
    a: ArrayLike<number>,
    b: ArrayLike<number>,
    epsilon?: number
  ): boolean => {
    epsilon = epsilon ?? 1e-6;
    return (
      Math.abs(a[0] - b[0]) < epsilon &&
      Math.abs(a[1] - b[1]) < epsilon &&
      Math.abs(a[2] - b[2]) < epsilon &&
      Math.abs(a[4] - b[4]) < epsilon &&
      Math.abs(a[5] - b[5]) < epsilon &&
      Math.abs(a[6] - b[6]) < epsilon &&
      Math.abs(a[8] - b[8]) < epsilon &&
      Math.abs(a[9] - b[9]) < epsilon &&
      Math.abs(a[10] - b[10]) < epsilon
    );
  },

  zero: (out?: Float32Array): Float32Array => {
    out = out ?? mat3.create();
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    out[4] = 0;
    out[5] = 0;
    out[6] = 0;
    out[7] = 0;
    out[8] = 0;
    out[9] = 0;
    out[10] = 0;
    out[11] = 0;
    return out;
  },

  one: (out?: Float32Array): Float32Array => {
    out = out ?? mat3.create();
    out[0] = 1;
    out[1] = 1;
    out[2] = 1;
    out[3] = 1;
    out[4] = 1;
    out[5] = 1;
    out[6] = 1;
    out[7] = 1;
    out[8] = 1;
    out[9] = 1;
    out[10] = 1;
    out[11] = 1;
    return out;
  },

  toArray: (mat: ArrayLike<number>, out?: number[]): number[] => {
    out = out ?? [];
    out.push(
      mat[0],
      mat[1],
      mat[2],
      mat[4],
      mat[5],
      mat[6],
      mat[8],
      mat[9],
      mat[10]
    );
    return out;
  },

  fromArray: (arr: number[], out?: Float32Array): Float32Array => {
    out = out ?? mat3.create();
    [0, 1, 2, 4, 5, 6, 8, 9, 10].map((n, i) => (out[n] = arr[i]));
    return out;
  },

  isIdentity: (mat: ArrayLike<number>, epsilon?: number): boolean => {
    epsilon = epsilon ?? 1e-6;
    return Mat3Api.equals(mat, mat3.identity(), epsilon);
  },

  isFinite: (mat: ArrayLike<number>): boolean => {
    return (
      Number.isFinite(mat[0]) &&
      Number.isFinite(mat[1]) &&
      Number.isFinite(mat[2]) &&
      Number.isFinite(mat[4]) &&
      Number.isFinite(mat[5]) &&
      Number.isFinite(mat[6]) &&
      Number.isFinite(mat[8]) &&
      Number.isFinite(mat[9]) &&
      Number.isFinite(mat[10])
    );
  },

  isNaN: (mat: ArrayLike<number>): boolean => {
    return (
      Number.isNaN(mat[0]) ||
      Number.isNaN(mat[1]) ||
      Number.isNaN(mat[2]) ||
      Number.isNaN(mat[4]) ||
      Number.isNaN(mat[5]) ||
      Number.isNaN(mat[6]) ||
      Number.isNaN(mat[8]) ||
      Number.isNaN(mat[9]) ||
      Number.isNaN(mat[10])
    );
  },

  str: (mat: ArrayLike<number>): string => {
    return `Mat3(${mat[0]}, ${mat[1]}, ${mat[2]}, ${mat[4]}, ${mat[5]}, ${mat[6]}, ${mat[8]}, ${mat[9]}, ${mat[10]})`;
  },
};

export default Mat3Api;
