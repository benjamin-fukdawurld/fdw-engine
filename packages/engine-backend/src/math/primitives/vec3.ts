export type Vec3Api = {
  add: (
    a: ArrayLike<number>,
    b: ArrayLike<number>,
    out?: Float32Array
  ) => Float32Array;
  subtract: (
    a: ArrayLike<number>,
    b: ArrayLike<number>,
    out?: Float32Array
  ) => Float32Array;
  multiply: (
    a: ArrayLike<number>,
    b: ArrayLike<number>,
    out?: Float32Array
  ) => Float32Array;
  divide: (
    a: ArrayLike<number>,
    b: ArrayLike<number>,
    out?: Float32Array
  ) => Float32Array;
  invert: (a: ArrayLike<number>, out?: Float32Array) => Float32Array;
  cross: (
    a: ArrayLike<number>,
    b: ArrayLike<number>,
    out?: Float32Array
  ) => Float32Array;
  dot: (a: ArrayLike<number>, b: ArrayLike<number>) => number;
  negate: (a: ArrayLike<number>, out?: Float32Array) => Float32Array;

  multiplyScalar: (
    a: ArrayLike<number>,
    scalar: number,
    out?: Float32Array
  ) => Float32Array;
  divideScalar: (
    a: ArrayLike<number>,
    scalar: number,
    out?: Float32Array
  ) => Float32Array;

  multiplyMat3: (
    v: ArrayLike<number>,
    m: ArrayLike<number>,
    out?: Float32Array
  ) => Float32Array;

  multiplyMat4: (
    v: ArrayLike<number>,
    m: ArrayLike<number>,
    out?: Float32Array
  ) => Float32Array;

  multiplyQuat: (
    v: ArrayLike<number>,
    q: ArrayLike<number>,
    out?: Float32Array
  ) => Float32Array;

  angle: (a: ArrayLike<number>, b: ArrayLike<number>) => number;
  length: (a: ArrayLike<number>) => number;
  lengthSquared: (a: ArrayLike<number>) => number;
  normalize: (a: ArrayLike<number>, out?: Float32Array) => Float32Array;

  distance: (a: ArrayLike<number>, b: ArrayLike<number>) => number;
  distanceSquared: (a: ArrayLike<number>, b: ArrayLike<number>) => number;

  lerp: (
    a: ArrayLike<number>,
    b: ArrayLike<number>,
    t: number,
    out?: Float32Array
  ) => Float32Array;

  create(): Float32Array;
  copy: (mat: ArrayLike<number>, out: Float32Array) => Float32Array;
  clone: (mat: ArrayLike<number>) => Float32Array;
  equals: (
    a: ArrayLike<number>,
    b: ArrayLike<number>,
    epsilon?: number
  ) => boolean;
  zero: (out?: Float32Array) => Float32Array;
  one: (out?: Float32Array) => Float32Array;
  toArray: (mat: ArrayLike<number>, out?: number[]) => number[];
  fromArray: (arr: ArrayLike<number>, out?: Float32Array) => Float32Array;

  isFinite: (mat: ArrayLike<number>) => boolean;
  isNaN: (mat: ArrayLike<number>) => boolean;

  str: (mat: ArrayLike<number>) => string;
};
