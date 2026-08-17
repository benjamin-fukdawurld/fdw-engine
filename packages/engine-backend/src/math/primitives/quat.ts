import type { RotationOrder } from './types';

export type QuatApi = {
  identity: (out?: Float32Array) => Float32Array;
  multiply: (
    a: Float32Array,
    b: Float32Array,
    out?: Float32Array
  ) => Float32Array;
  invert: (a: Float32Array, out?: Float32Array) => Float32Array;
  conjugate: (a: Float32Array, out?: Float32Array) => Float32Array;
  add: (a: Float32Array, b: Float32Array, out?: Float32Array) => Float32Array;
  subtract: (
    a: Float32Array,
    b: Float32Array,
    out?: Float32Array
  ) => Float32Array;
  multiplyScalar: (
    a: Float32Array,
    scalar: number,
    out?: Float32Array
  ) => Float32Array;
  divideScalar: (
    a: Float32Array,
    scalar: number,
    out?: Float32Array
  ) => Float32Array;
  dot: (a: Float32Array, b: Float32Array) => number;

  slerp: (
    a: Float32Array,
    b: Float32Array,
    t: number,
    out?: Float32Array
  ) => Float32Array;
  lerp: (
    a: Float32Array,
    b: Float32Array,
    t: number,
    out?: Float32Array
  ) => Float32Array;

  length: (a: Float32Array) => number;
  lengthSquared: (a: Float32Array) => number;
  normalize: (a: Float32Array, out?: Float32Array) => Float32Array;

  angle: (a: Float32Array, b: Float32Array) => number;
  fromAxisAngle: (
    axis: Float32Array,
    rad: number,
    out?: Float32Array
  ) => Float32Array;
  toAxisAngle: (
    a: Float32Array,
    outAxis?: Float32Array
  ) => { angle: number; axis: Float32Array };
  fromEuler: (
    x: number,
    y: number,
    z: number,
    order?: RotationOrder,
    out?: Float32Array
  ) => Float32Array;
  fromMat3: (m: Float32Array, out?: Float32Array) => Float32Array;
  fromMat4: (m: Float32Array, out?: Float32Array) => Float32Array;

  create(): Float32Array;
  copy: (mat: Float32Array, out: Float32Array) => Float32Array;
  clone: (mat: Float32Array) => Float32Array;
  equals: (a: Float32Array, b: Float32Array, epsilon?: number) => boolean;
  toArray: (mat: Float32Array, out?: number[]) => number[];
  fromArray: (arr: number[], out?: Float32Array) => Float32Array;

  isIdentity: (mat: Float32Array, epsilon?: number) => boolean;
  isFinite: (mat: Float32Array) => boolean;
  isNaN: (mat: Float32Array) => boolean;

  str: (mat: Float32Array) => string;
};
