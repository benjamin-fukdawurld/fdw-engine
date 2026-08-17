export type Mat3Api = {
  identity: (out?: Float32Array) => Float32Array;
  premultiply: (
    a: ArrayLike<number>,
    b: ArrayLike<number>,
    out?: Float32Array
  ) => Float32Array;
  multiply: (
    a: ArrayLike<number>,
    b: ArrayLike<number>,
    out?: Float32Array
  ) => Float32Array;
  invert: (a: ArrayLike<number>, out?: Float32Array) => Float32Array;
  transpose: (a: ArrayLike<number>, out?: Float32Array) => Float32Array;

  negate: (a: ArrayLike<number>, out?: Float32Array) => Float32Array;
  multiplyScalar: (
    a: ArrayLike<number>,
    scalar: number,
    out?: Float32Array
  ) => Float32Array;
  add: (
    a: ArrayLike<number>,
    b: ArrayLike<number>,
    out?: Float32Array
  ) => Float32Array;

  determinant: (mat: ArrayLike<number>) => number;

  fromMat4: (mat4: ArrayLike<number>, out?: Float32Array) => Float32Array;

  create: () => Float32Array;
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
  fromArray: (arr: number[], out?: Float32Array) => Float32Array;

  isIdentity: (mat: ArrayLike<number>, epsilon?: number) => boolean;
  isFinite: (mat: ArrayLike<number>) => boolean;
  isNaN: (mat: ArrayLike<number>) => boolean;

  str: (mat: ArrayLike<number>) => string;
};
