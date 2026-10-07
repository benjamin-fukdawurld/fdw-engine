import { QuatApi as IQuatApi, RotationOrder } from '@fdw/engine-backend';
import { quat } from 'wgpu-matrix';

export const QuatApi: IQuatApi = {
  identity: (out?: Float32Array): Float32Array => {
    return quat.identity(out);
  },
  multiply: (
    a: Float32Array,
    b: Float32Array,
    out?: Float32Array
  ): Float32Array => {
    return quat.multiply(a, b, out);
  },
  invert: (a: Float32Array, out?: Float32Array): Float32Array => {
    return quat.inverse(a, out);
  },
  conjugate: (a: Float32Array, out?: Float32Array): Float32Array => {
    return quat.conjugate(a, out);
  },
  add: (a: Float32Array, b: Float32Array, out?: Float32Array): Float32Array => {
    return quat.add(a, b, out);
  },
  subtract: (
    a: Float32Array,
    b: Float32Array,
    out?: Float32Array
  ): Float32Array => {
    return quat.subtract(a, b, out);
  },
  multiplyScalar: (
    a: Float32Array,
    scalar: number,
    out?: Float32Array
  ): Float32Array => {
    return quat.mulScalar(a, scalar, out);
  },
  divideScalar: (
    a: Float32Array,
    scalar: number,
    out?: Float32Array
  ): Float32Array => {
    return quat.divScalar(a, scalar, out);
  },
  dot: (a: Float32Array, b: Float32Array): number => {
    return quat.dot(a, b);
  },

  slerp: (
    a: Float32Array,
    b: Float32Array,
    t: number,
    out?: Float32Array
  ): Float32Array => {
    return quat.slerp(a, b, t, out);
  },
  lerp: (
    a: Float32Array,
    b: Float32Array,
    t: number,
    out?: Float32Array
  ): Float32Array => {
    return quat.lerp(a, b, t, out);
  },

  length: (a: Float32Array): number => {
    return quat.length(a);
  },
  lengthSquared: (a: Float32Array): number => {
    return quat.lengthSq(a);
  },
  normalize: (a: Float32Array, out?: Float32Array): Float32Array => {
    return quat.normalize(a, out);
  },

  angle: (a: Float32Array, b: Float32Array): number => {
    return quat.angle(a, b);
  },
  fromAxisAngle: (
    axis: Float32Array,
    rad: number,
    out?: Float32Array
  ): Float32Array => {
    return quat.fromAxisAngle(axis, rad, out);
  },
  toAxisAngle: (
    a: Float32Array,
    outAxis?: Float32Array
  ): { angle: number; axis: Float32Array } => {
    return quat.toAxisAngle(a, outAxis);
  },
  fromEuler: (
    x: number,
    y: number,
    z: number,
    order?: RotationOrder,
    out?: Float32Array
  ): Float32Array => {
    return quat.fromEuler(x, y, z, order ?? 'xyz', out);
  },
  fromMat3: (m: Float32Array, out?: Float32Array): Float32Array => {
    return quat.fromMat(m, out);
  },
  fromMat4: (m: Float32Array, out?: Float32Array): Float32Array => {
    return quat.fromMat(m, out);
  },

  create: (): Float32Array => {
    return quat.create();
  },
  copy: (mat: Float32Array, out: Float32Array): Float32Array => {
    return quat.copy(mat, out);
  },
  clone: (mat: Float32Array): Float32Array => {
    return quat.clone(mat);
  },
  equals: (a: Float32Array, b: Float32Array, epsilon?: number): boolean => {
    return a.every(
      (value, index) => Math.abs(value - b[index]) <= (epsilon ?? 0)
    );
  },
  toArray: (mat: Float32Array, out?: number[]): number[] => {
    out = out ?? [];
    for (let i = 0; i < 4; i++) {
      out[i] = mat[i];
    }
    return out;
  },
  fromArray: (arr: number[], out?: Float32Array): Float32Array => {
    out = out ?? quat.create();
    for (let i = 0; i < 4; i++) {
      out[i] = arr[i];
    }
    return out;
  },

  isIdentity: (q: Float32Array, epsilon?: number): boolean => {
    return QuatApi.equals(q, QuatApi.identity(), epsilon);
  },

  isFinite: (q: Float32Array): boolean => {
    return (
      Number.isFinite(q[0]) &&
      Number.isFinite(q[1]) &&
      Number.isFinite(q[2]) &&
      Number.isFinite(q[3])
    );
  },
  isNaN: (q: Float32Array): boolean => {
    return (
      Number.isNaN(q[0]) ||
      Number.isNaN(q[1]) ||
      Number.isNaN(q[2]) ||
      Number.isNaN(q[3])
    );
  },

  str: (mat: Float32Array): string => {
    return `Quat(${mat[0]}, ${mat[1]}, ${mat[2]}, ${mat[3]})`;
  },
};

export default QuatApi;
