// The quaternions and the matrix decompositions of the tools. Vectors are
// [x, y, z] arrays (those of @fdw/engine-geometry), quaternions [x, y, z, w]
// arrays, matrices 4 × 4 column-major.
import {
  cross,
  dot,
  length,
  type Matrix4,
  type ReadonlyVec3,
  type Vec3,
  vec3,
} from '@fdw/engine-geometry';

/** A unit quaternion: [x, y, z, w]. */
export type Quat = [number, number, number, number];
export type ReadonlyQuat = readonly [number, number, number, number];

export const identityQuat = (): Quat => [0, 0, 0, 1];

/** a × b: the rotation b, then a. */
export function multiplyQuat(a: ReadonlyQuat, b: ReadonlyQuat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export const conjugate = ([x, y, z, w]: ReadonlyQuat): Quat => [-x, -y, -z, w];

export function normalizeQuat(q: ReadonlyQuat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** The rotation of `angle` radians around a unit axis. */
export function axisAngle(axis: ReadonlyVec3, angle: number): Quat {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}

/** The vector rotated by the quaternion. */
export function rotate(q: ReadonlyQuat, v: ReadonlyVec3): Vec3 {
  // v + 2w (u × v) + 2 u × (u × v), u the vector part.
  const u: ReadonlyVec3 = [q[0], q[1], q[2]];
  const t = cross(vec3(), u, v);
  t[0] *= 2;
  t[1] *= 2;
  t[2] *= 2;
  const c = cross(vec3(), u, t);
  return [
    v[0] + q[3] * t[0] + c[0],
    v[1] + q[3] * t[1] + c[1],
    v[2] + q[3] * t[2] + c[2],
  ];
}

/** The rotation of a matrix whose columns are orthonormal axes. */
export function quatFromAxes(
  x: ReadonlyVec3,
  y: ReadonlyVec3,
  z: ReadonlyVec3,
): Quat {
  // Shepperd's method, on the rotation matrix of columns x, y, z.
  const trace = x[0] + y[1] + z[2];
  let q: Quat;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [(y[2] - z[1]) / s, (z[0] - x[2]) / s, (x[1] - y[0]) / s, s / 4];
  } else if (x[0] > y[1] && x[0] > z[2]) {
    const s = Math.sqrt(1 + x[0] - y[1] - z[2]) * 2;
    q = [s / 4, (y[0] + x[1]) / s, (z[0] + x[2]) / s, (y[2] - z[1]) / s];
  } else if (y[1] > z[2]) {
    const s = Math.sqrt(1 + y[1] - x[0] - z[2]) * 2;
    q = [(y[0] + x[1]) / s, s / 4, (z[1] + y[2]) / s, (z[0] - x[2]) / s];
  } else {
    const s = Math.sqrt(1 + z[2] - x[0] - y[1]) * 2;
    q = [(z[0] + x[2]) / s, (z[1] + y[2]) / s, s / 4, (x[1] - y[0]) / s];
  }
  return normalizeQuat(q);
}

/** Position, rotation and scale. */
export interface Trs {
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly scale: Vec3;
}

/**
 * The translation, rotation and scale of a world matrix, without shear (the
 * shear of a non-uniform scale under a rotation is lost). A mirrored matrix
 * gets a negative x scale.
 */
export function decompose(m: Matrix4): Trs {
  const x: Vec3 = [m[0], m[1], m[2]];
  const y: Vec3 = [m[4], m[5], m[6]];
  const z: Vec3 = [m[8], m[9], m[10]];
  let sx = length(x);
  const sy = length(y);
  const sz = length(z);
  if (dot(cross(vec3(), x, y), z) < 0) {
    sx = -sx;
  }
  const axis = (a: Vec3, s: number): Vec3 =>
    s === 0 ? a : [a[0] / s, a[1] / s, a[2] / s];
  return {
    position: [m[12], m[13], m[14]],
    rotation: quatFromAxes(axis(x, sx), axis(y, sy), axis(z, sz)),
    scale: [sx, sy, sz],
  };
}

/** The rotation of a matrix, its scale left out. */
export const rotationOf = (m: Matrix4): Quat => decompose(m).rotation;

/** The matrix of a position, a rotation and a scale. */
export function compose(
  position: ReadonlyVec3,
  rotation: ReadonlyQuat,
  scale: ReadonlyVec3,
): Float64Array {
  const [x, y, z, w] = rotation;
  const [sx, sy, sz] = scale;
  const out = new Float64Array(16);
  out[0] = (1 - 2 * (y * y + z * z)) * sx;
  out[1] = 2 * (x * y + z * w) * sx;
  out[2] = 2 * (x * z - y * w) * sx;
  out[4] = 2 * (x * y - z * w) * sy;
  out[5] = (1 - 2 * (x * x + z * z)) * sy;
  out[6] = 2 * (y * z + x * w) * sy;
  out[8] = 2 * (x * z + y * w) * sz;
  out[9] = 2 * (y * z - x * w) * sz;
  out[10] = (1 - 2 * (x * x + y * y)) * sz;
  out[12] = position[0];
  out[13] = position[1];
  out[14] = position[2];
  out[15] = 1;
  return out;
}

/** a × b. */
export function multiplyMatrices(a: Matrix4, b: Matrix4): Float64Array {
  const out = new Float64Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += a[k * 4 + row] * b[column * 4 + k];
      }
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

/** The value rounded to the nearest multiple of a step (none: unchanged). */
export const snap = (value: number, step: number | undefined): number =>
  step ? Math.round(value / step) * step : value;
