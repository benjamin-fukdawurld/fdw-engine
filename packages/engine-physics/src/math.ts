// The little math of the binding: poses read from world matrices, and
// interpolated between two steps.

/**
 * The pose (position, rotation) of a column-major matrix, at `offset` of
 * `out`: its scale removed.
 */
export function poseOfMatrix(
  m: ArrayLike<number>,
  out: Float32Array | number[],
  offset = 0,
): void {
  out[offset] = m[12];
  out[offset + 1] = m[13];
  out[offset + 2] = m[14];
  const sx = Math.hypot(m[0], m[1], m[2]) || 1;
  const sy = Math.hypot(m[4], m[5], m[6]) || 1;
  const sz = Math.hypot(m[8], m[9], m[10]) || 1;
  // The rotation matrix, by rows: rij is row i, column j.
  const r00 = m[0] / sx;
  const r10 = m[1] / sx;
  const r20 = m[2] / sx;
  const r01 = m[4] / sy;
  const r11 = m[5] / sy;
  const r21 = m[6] / sy;
  const r02 = m[8] / sz;
  const r12 = m[9] / sz;
  const r22 = m[10] / sz;
  const trace = r00 + r11 + r22;
  let x: number;
  let y: number;
  let z: number;
  let w: number;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    w = 0.25 / s;
    x = (r21 - r12) * s;
    y = (r02 - r20) * s;
    z = (r10 - r01) * s;
  } else if (r00 > r11 && r00 > r22) {
    const s = 2 * Math.sqrt(1 + r00 - r11 - r22);
    w = (r21 - r12) / s;
    x = 0.25 * s;
    y = (r01 + r10) / s;
    z = (r02 + r20) / s;
  } else if (r11 > r22) {
    const s = 2 * Math.sqrt(1 + r11 - r00 - r22);
    w = (r02 - r20) / s;
    x = (r01 + r10) / s;
    y = 0.25 * s;
    z = (r12 + r21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + r22 - r00 - r11);
    w = (r10 - r01) / s;
    x = (r02 + r20) / s;
    y = (r12 + r21) / s;
    z = 0.25 * s;
  }
  const length = Math.hypot(x, y, z, w) || 1;
  out[offset + 3] = x / length;
  out[offset + 4] = y / length;
  out[offset + 5] = z / length;
  out[offset + 6] = w / length;
}

/**
 * Between two poses (at `a` and `b` of `poses`), by `t` from 0 to 1: the
 * positions mixed, the rotations by nlerp along the shortest path.
 * Writes position then rotation at `offset` of `out`.
 */
export function mixPoses(
  poses: Float32Array,
  a: number,
  b: number,
  t: number,
  out: Float32Array,
  position: number,
  rotation: number,
): void {
  for (let i = 0; i < 3; i++) {
    out[position + i] = poses[a + i] + (poses[b + i] - poses[a + i]) * t;
  }
  const dot =
    poses[a + 3] * poses[b + 3] +
    poses[a + 4] * poses[b + 4] +
    poses[a + 5] * poses[b + 5] +
    poses[a + 6] * poses[b + 6];
  const sign = dot < 0 ? -1 : 1;
  let length = 0;
  for (let i = 3; i < 7; i++) {
    const value = poses[a + i] + (sign * poses[b + i] - poses[a + i]) * t;
    out[rotation + i - 3] = value;
    length += value * value;
  }
  length = Math.sqrt(length) || 1;
  for (let i = 0; i < 4; i++) {
    out[rotation + i] /= length;
  }
}

/** Rotates (x, y, z) by the quaternion at `q` of `pose`, into `out`. */
export function rotate(
  pose: ArrayLike<number>,
  q: number,
  x: number,
  y: number,
  z: number,
  out: number[],
  offset = 0,
): void {
  const qx = pose[q];
  const qy = pose[q + 1];
  const qz = pose[q + 2];
  const qw = pose[q + 3];
  // t = 2 q × v; v + w t + q × t
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[offset] = x + qw * tx + (qy * tz - qz * ty);
  out[offset + 1] = y + qw * ty + (qz * tx - qx * tz);
  out[offset + 2] = z + qw * tz + (qx * ty - qy * tx);
}
