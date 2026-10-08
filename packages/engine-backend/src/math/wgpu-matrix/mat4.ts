import type { Mat4Api as IMat4Api } from '../primitives';
import { mat3, mat4, quat, vec3 } from 'wgpu-matrix';

export const Mat4Api: IMat4Api = {
  identity: (out?: Float32Array): Float32Array => {
    return mat4.identity(out);
  },

  premultiply: (
    a: ArrayLike<number>,
    b: ArrayLike<number>,
    out?: Float32Array
  ): Float32Array => {
    return mat4.multiply(b, a, out);
  },

  multiply: (
    a: ArrayLike<number>,
    b: ArrayLike<number>,
    out?: Float32Array
  ): Float32Array => {
    return mat4.multiply(a, b, out);
  },

  invert: (a: ArrayLike<number>, out?: Float32Array): Float32Array => {
    return mat4.invert(a, out);
  },

  transpose: (a: ArrayLike<number>, out?: Float32Array): Float32Array => {
    return mat4.transpose(a, out);
  },

  negate: (a: ArrayLike<number>, out?: Float32Array): Float32Array => {
    return mat4.negate(a, out);
  },

  add: (
    a: ArrayLike<number>,
    b: ArrayLike<number>,
    out?: Float32Array
  ): Float32Array => {
    return mat4.add(a, b, out);
  },

  multiplyScalar: (
    a: ArrayLike<number>,
    scalar: number,
    out?: Float32Array
  ): Float32Array => {
    return mat4.multiplyScalar(a, scalar, out);
  },

  aim: (
    position: ArrayLike<number>,
    target: ArrayLike<number>,
    up: ArrayLike<number>,
    out?: Float32Array
  ): Float32Array => {
    return mat4.aim(position, target, up, out);
  },

  cameraAim: (
    eye: ArrayLike<number>,
    target: ArrayLike<number>,
    up: ArrayLike<number>,
    out?: Float32Array
  ): Float32Array => {
    return mat4.cameraAim(eye, target, up, out);
  },

  lookAt: (
    eye: ArrayLike<number>,
    center: ArrayLike<number>,
    up: ArrayLike<number>,
    out?: Float32Array
  ): Float32Array => {
    return mat4.lookAt(eye, center, up, out);
  },

  perspective: (
    fovy: number,
    aspect: number,
    near: number,
    far: number,
    out?: Float32Array
  ): Float32Array => {
    return mat4.perspective(fovy, aspect, near, far, out);
  },

  ortho: (
    left: number,
    right: number,
    bottom: number,
    top: number,
    near: number,
    far: number,
    out?: Float32Array
  ): Float32Array => {
    return mat4.ortho(left, right, bottom, top, near, far, out);
  },

  fromTranslation: (
    translation: ArrayLike<number>,
    out?: Float32Array
  ): Float32Array => {
    return mat4.translation(translation, out);
  },

  fromAxisAngle: (
    rad: number,
    axis: ArrayLike<number>,
    out?: Float32Array
  ): Float32Array => {
    return mat4.axisRotation(axis, rad, out);
  },

  fromScaling: (scale: ArrayLike<number>, out?: Float32Array): Float32Array => {
    return mat4.scaling(scale, out);
  },

  fromQuat: (q: ArrayLike<number>, out?: Float32Array): Float32Array => {
    return mat4.fromQuat(q, out);
  },

  fromMat3: (m3: ArrayLike<number>, out?: Float32Array): Float32Array => {
    return mat4.fromMat3(m3, out);
  },

  getTranslation: (
    mat: ArrayLike<number>,
    out?: Float32Array
  ): Float32Array => {
    return mat4.getTranslation(mat, out);
  },

  getScaling: (mat: ArrayLike<number>, out?: Float32Array): Float32Array => {
    return mat4.getScaling(mat, out);
  },

  getRotation: (mat: ArrayLike<number>, out?: Float32Array): Float32Array => {
    return quat.fromMat(mat, out);
  },

  setTranslation: (
    mat: ArrayLike<number>,
    translation: ArrayLike<number>,
    out?: Float32Array
  ): Float32Array => {
    return mat4.setTranslation(mat, translation, out);
  },

  setScaling: (
    mat: ArrayLike<number>,
    scale: ArrayLike<number>,
    out?: Float32Array
  ): Float32Array => {
    return mat4.scale(mat, vec3.div(scale, mat4.getScaling(mat)), out);
  },

  setRotation: (
    mat: ArrayLike<number>,
    q: ArrayLike<number>,
    out?: Float32Array
  ): Float32Array => {
    const currentRotation = Mat4Api.getRotation(mat) as ArrayLike<number>;
    const quaternion = quat.mul(q, quat.inverse(currentRotation));

    return mat4.multiply(mat, mat4.fromQuat(quaternion), out);
  },

  getMat3: (mat: ArrayLike<number>, out?: Float32Array): Float32Array => {
    return mat3.fromMat4(mat, out);
  },

  translate: (
    mat: ArrayLike<number>,
    translation: ArrayLike<number>,
    out?: Float32Array
  ): Float32Array => {
    return mat4.translate(mat, translation, out);
  },

  rotateAxisAngle: (
    mat: ArrayLike<number>,
    rad: number,
    axis: ArrayLike<number>,
    out?: Float32Array
  ): Float32Array => {
    return mat4.rotate(mat, axis, rad, out);
  },

  scale: (
    mat: ArrayLike<number>,
    scale: ArrayLike<number>,
    out?: Float32Array
  ): Float32Array => {
    return mat4.scale(mat, scale, out);
  },

  rotateQuat: (
    mat: ArrayLike<number>,
    q: ArrayLike<number>,
    out?: Float32Array
  ): Float32Array => {
    return mat4.multiply(mat, mat4.fromQuat(q), out);
  },

  determinant: (mat: ArrayLike<number>): number => {
    return mat4.determinant(mat);
  },

  create: (): Float32Array => {
    return mat4.create();
  },

  copy: (mat: ArrayLike<number>, out?: Float32Array): Float32Array => {
    return mat4.copy(mat, out);
  },

  clone: (mat: ArrayLike<number>): Float32Array => {
    return mat4.clone(mat);
  },

  equals: (
    a: ArrayLike<number>,
    b: ArrayLike<number>,
    epsilon?: number
  ): boolean => {
    epsilon = epsilon ?? 1e-6;
    for (let i = 0; i < 16; i++) {
      if (Math.abs(a[i] - b[i]) >= epsilon) {
        return false;
      }
    }

    return true;
  },

  zero: (out?: Float32Array): Float32Array => {
    out = out ?? mat4.create();
    for (let i = 0; i < 16; i++) {
      out[i] = 0;
    }
    return out;
  },

  one: (out?: Float32Array): Float32Array => {
    out = out ?? mat4.create();
    for (let i = 0; i < 16; i++) {
      out[i] = 1;
    }
    return out;
  },

  toArray: (mat: ArrayLike<number>, out?: number[]): number[] => {
    out = out ?? new Array(16);
    for (let i = 0; i < 16; i++) {
      out[i] = mat[i];
    }
    return out;
  },
  fromArray: (arr: number[], out?: Float32Array): Float32Array => {
    out = out ?? mat4.create();
    for (let i = 0; i < 16; i++) {
      out[i] = arr[i];
    }
    return out;
  },

  isIdentity: (mat: ArrayLike<number>, epsilon?: number): boolean => {
    epsilon = epsilon ?? 1e-6;
    return Mat4Api.equals(mat, mat4.identity(), epsilon);
  },

  isFinite: (mat: ArrayLike<number>): boolean => {
    for (let i = 0; i < 16; i++) {
      if (!Number.isFinite(mat[i])) {
        return false;
      }
    }
    return true;
  },
  isNaN: (mat: ArrayLike<number>): boolean => {
    for (let i = 0; i < 16; i++) {
      if (Number.isNaN(mat[i])) {
        return true;
      }
    }
    return false;
  },

  str: (mat: ArrayLike<number>): string => {
    return `Mat4(${Array.from(mat).join(', ')})`;
  },
};

export default Mat4Api;
