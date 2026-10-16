export type Mat4Api = {
  identity: (out?: Float32Array) => Float32Array;
  premultiply: (
    a: ArrayLike<number>,
    b: ArrayLike<number>,
    out?: Float32Array,
  ) => Float32Array;
  multiply: (
    a: ArrayLike<number>,
    b: ArrayLike<number>,
    out?: Float32Array,
  ) => Float32Array;
  invert: (a: ArrayLike<number>, out?: Float32Array) => Float32Array;
  transpose: (a: ArrayLike<number>, out?: Float32Array) => Float32Array;

  negate: (a: ArrayLike<number>, out?: Float32Array) => Float32Array;
  add: (
    a: ArrayLike<number>,
    b: ArrayLike<number>,
    out?: Float32Array,
  ) => Float32Array;
  multiplyScalar: (
    a: ArrayLike<number>,
    scalar: number,
    out?: Float32Array,
  ) => Float32Array;

  aim: (
    position: ArrayLike<number>,
    target: ArrayLike<number>,
    up: ArrayLike<number>,
    out?: Float32Array,
  ) => Float32Array;
  cameraAim: (
    eye: ArrayLike<number>,
    target: ArrayLike<number>,
    up: ArrayLike<number>,
    out?: Float32Array,
  ) => Float32Array;
  lookAt: (
    eye: ArrayLike<number>,
    center: ArrayLike<number>,
    up: ArrayLike<number>,
    out?: Float32Array,
  ) => Float32Array;
  perspective: (
    fovy: number,
    aspect: number,
    near: number,
    far: number,
    out?: Float32Array,
  ) => Float32Array;
  ortho: (
    left: number,
    right: number,
    bottom: number,
    top: number,
    near: number,
    far: number,
    out?: Float32Array,
  ) => Float32Array;

  fromTranslation: (
    translation: ArrayLike<number>,
    out?: Float32Array,
  ) => Float32Array;
  fromAxisAngle: (
    rad: number,
    axis: ArrayLike<number>,
    out?: Float32Array,
  ) => Float32Array;
  fromScaling: (scale: ArrayLike<number>, out?: Float32Array) => Float32Array;
  fromQuat: (q: ArrayLike<number>, out?: Float32Array) => Float32Array;
  fromMat3: (m3: ArrayLike<number>, out?: Float32Array) => Float32Array;

  getTranslation: (mat: ArrayLike<number>, out?: Float32Array) => Float32Array;
  getScaling: (mat: ArrayLike<number>, out?: Float32Array) => Float32Array;
  getRotation: (mat: ArrayLike<number>, out?: Float32Array) => Float32Array;
  setTranslation: (
    mat: ArrayLike<number>,
    translation: ArrayLike<number>,
    out?: Float32Array,
  ) => Float32Array;
  setScaling: (
    mat: ArrayLike<number>,
    scale: ArrayLike<number>,
    out?: Float32Array,
  ) => Float32Array;
  setRotation: (
    mat: ArrayLike<number>,
    q: ArrayLike<number>,
    out?: Float32Array,
  ) => Float32Array;
  getMat3: (mat: ArrayLike<number>, out?: Float32Array) => Float32Array;

  translate: (
    mat: ArrayLike<number>,
    translation: ArrayLike<number>,
    out?: Float32Array,
  ) => Float32Array;
  rotateAxisAngle: (
    mat: ArrayLike<number>,
    rad: number,
    axis: ArrayLike<number>,
    out?: Float32Array,
  ) => Float32Array;
  scale: (
    mat: ArrayLike<number>,
    scale: ArrayLike<number>,
    out?: Float32Array,
  ) => Float32Array;
  rotateQuat: (
    mat: ArrayLike<number>,
    q: ArrayLike<number>,
    out?: Float32Array,
  ) => Float32Array;

  determinant: (mat: ArrayLike<number>) => number;

  create(): Float32Array;
  copy: (mat: ArrayLike<number>, out: Float32Array) => Float32Array;
  clone: (mat: ArrayLike<number>) => Float32Array;
  equals: (
    a: ArrayLike<number>,
    b: ArrayLike<number>,
    epsilon?: number,
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
