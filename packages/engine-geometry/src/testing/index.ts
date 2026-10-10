// Helpers of the tests: a seeded random generator, and matrices built from
// translations, rotations and scales.
import type { Vec3 } from '../math';

/** A reproducible random generator (mulberry32), in [0, 1). */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const between = (next: () => number, low: number, high: number) =>
  low + (high - low) * next();

export const randomPoint = (next: () => number, extent: number): Vec3 => [
  between(next, -extent, extent),
  between(next, -extent, extent),
  between(next, -extent, extent),
];

/**
 * A column-major matrix: translation × rotation (unit quaternion) × scale.
 */
export function compose(
  [tx, ty, tz]: readonly number[],
  [x, y, z, w]: readonly number[],
  [sx, sy, sz]: readonly number[]
): Float64Array {
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  return Float64Array.of(
    (1 - 2 * (yy + zz)) * sx,
    2 * (xy + wz) * sx,
    2 * (xz - wy) * sx,
    0,
    2 * (xy - wz) * sy,
    (1 - 2 * (xx + zz)) * sy,
    2 * (yz + wx) * sy,
    0,
    2 * (xz + wy) * sz,
    2 * (yz - wx) * sz,
    (1 - 2 * (xx + yy)) * sz,
    0,
    tx,
    ty,
    tz,
    1
  );
}

/** A random unit quaternion. */
export function randomRotation(
  next: () => number
): [number, number, number, number] {
  const q = [next() - 0.5, next() - 0.5, next() - 0.5, next() - 0.5];
  const l = Math.hypot(...q) || 1;
  return q.map((c) => c / l) as [number, number, number, number];
}

/**
 * A perspective view-projection, depth from 0 to 1, for a camera at `eye`
 * looking down -z (no rotation).
 */
export function perspective(
  fovY: number,
  aspect: number,
  near: number,
  far: number,
  eye: readonly number[] = [0, 0, 0]
): Float64Array {
  const f = 1 / Math.tan(fovY / 2);
  const projection = Float64Array.of(
    f / aspect,
    0,
    0,
    0,
    0,
    f,
    0,
    0,
    0,
    0,
    far / (near - far),
    -1,
    0,
    0,
    (near * far) / (near - far),
    0
  );
  // × view: a translation by -eye.
  const out = Float64Array.from(projection);
  for (let row = 0; row < 4; row++) {
    out[12 + row] =
      projection[row] * -eye[0] +
      projection[4 + row] * -eye[1] +
      projection[8 + row] * -eye[2] +
      projection[12 + row];
  }
  return out;
}
