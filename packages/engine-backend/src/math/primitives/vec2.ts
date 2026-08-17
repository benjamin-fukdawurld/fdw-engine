export type Vec2Api = {
  add: (a: Float32Array, b: Float32Array, out?: Float32Array) => Float32Array;
  subtract: (
    a: Float32Array,
    b: Float32Array,
    out?: Float32Array
  ) => Float32Array;
  multiply: (
    a: Float32Array,
    b: Float32Array,
    out?: Float32Array
  ) => Float32Array;
  divide: (
    a: Float32Array,
    b: Float32Array,
    out?: Float32Array
  ) => Float32Array;
  invert: (a: Float32Array, out?: Float32Array) => Float32Array;
  dot: (a: Float32Array, b: Float32Array) => number;
  negate: (a: Float32Array, out?: Float32Array) => Float32Array;

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

  angle: (a: Float32Array, b: Float32Array) => number;
  length: (a: Float32Array) => number;
  lengthSquared: (a: Float32Array) => number;
  normalize: (a: Float32Array, out?: Float32Array) => Float32Array;

  distance: (a: Float32Array, b: Float32Array) => number;
  distanceSquared: (a: Float32Array, b: Float32Array) => number;

  lerp: (
    a: Float32Array,
    b: Float32Array,
    t: number,
    out?: Float32Array
  ) => Float32Array;

  create(): Float32Array;
  copy: (mat: Float32Array, out: Float32Array) => Float32Array;
  clone: (mat: Float32Array) => Float32Array;
  equals: (a: Float32Array, b: Float32Array, epsilon?: number) => boolean;
  zero: (out?: Float32Array) => Float32Array;
  one: (out?: Float32Array) => Float32Array;
  toArray: (mat: Float32Array, out?: number[]) => number[];
  fromArray: (arr: number[], out?: Float32Array) => Float32Array;

  isFinite: (mat: Float32Array) => boolean;
  isNaN: (mat: Float32Array) => boolean;

  str: (mat: Float32Array) => string;
};
