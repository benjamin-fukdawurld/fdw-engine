// Quaternions (x, y, z, w) and matrices (column-major) in flat arrays, at
// an offset: the poses keep all their joints in one array per channel.

// Read-only inputs, and outputs.
type Floats = ArrayLike<number>;
type Out = { [index: number]: number };

/**
 * The quaternion between `a` and `b` along the shortest arc, normalized:
 * a(1 − t) + bt, b negated when the two are in opposite hemispheres. Close
 * to the spherical interpolation for nearby quaternions, and cheaper: the
 * blends of poses use it.
 */
export function nlerp(
  a: Floats,
  ai: number,
  b: Floats,
  bi: number,
  t: number,
  out: Out,
  oi: number,
): void {
  const dot =
    a[ai] * b[bi] +
    a[ai + 1] * b[bi + 1] +
    a[ai + 2] * b[bi + 2] +
    a[ai + 3] * b[bi + 3];
  const s = 1 - t;
  const u = dot < 0 ? -t : t;
  const x = a[ai] * s + b[bi] * u;
  const y = a[ai + 1] * s + b[bi + 1] * u;
  const z = a[ai + 2] * s + b[bi + 2] * u;
  const w = a[ai + 3] * s + b[bi + 3] * u;
  const length = Math.hypot(x, y, z, w) || 1;
  out[oi] = x / length;
  out[oi + 1] = y / length;
  out[oi + 2] = z / length;
  out[oi + 3] = w / length;
}

/**
 * The spherical interpolation between two unit quaternions, along the
 * shortest arc: the `LINEAR` interpolation of the rotations of glTF.
 */
export function slerp(
  a: Floats,
  ai: number,
  b: Floats,
  bi: number,
  t: number,
  out: Out,
  oi: number,
): void {
  let dot =
    a[ai] * b[bi] +
    a[ai + 1] * b[bi + 1] +
    a[ai + 2] * b[bi + 2] +
    a[ai + 3] * b[bi + 3];
  let sign = 1;
  if (dot < 0) {
    dot = -dot;
    sign = -1;
  }
  // Nearly the same rotation: the linear interpolation is exact enough.
  if (dot > 0.9995) {
    nlerp(a, ai, b, bi, t, out, oi);
    return;
  }
  const angle = Math.acos(dot);
  const sin = Math.sin(angle);
  const s = Math.sin((1 - t) * angle) / sin;
  const u = (sign * Math.sin(t * angle)) / sin;
  out[oi] = a[ai] * s + b[bi] * u;
  out[oi + 1] = a[ai + 1] * s + b[bi + 1] * u;
  out[oi + 2] = a[ai + 2] * s + b[bi + 2] * u;
  out[oi + 3] = a[ai + 3] * s + b[bi + 3] * u;
}

/** out = a × b: the rotation b, then a. `out` may be `a` or `b`. */
export function multiplyQuat(
  a: Floats,
  ai: number,
  b: Floats,
  bi: number,
  out: Out,
  oi: number,
): void {
  const ax = a[ai];
  const ay = a[ai + 1];
  const az = a[ai + 2];
  const aw = a[ai + 3];
  const bx = b[bi];
  const by = b[bi + 1];
  const bz = b[bi + 2];
  const bw = b[bi + 3];
  out[oi] = aw * bx + ax * bw + ay * bz - az * by;
  out[oi + 1] = aw * by - ax * bz + ay * bw + az * bx;
  out[oi + 2] = aw * bz + ax * by - ay * bx + az * bw;
  out[oi + 3] = aw * bw - ax * bx - ay * by - az * bz;
}

/** Normalizes the quaternion at `i`; the identity if it is zero. */
export function normalizeQuat(q: Out & Floats, i: number): void {
  const length = Math.hypot(q[i], q[i + 1], q[i + 2], q[i + 3]);
  if (length === 0) {
    q[i] = 0;
    q[i + 1] = 0;
    q[i + 2] = 0;
    q[i + 3] = 1;
    return;
  }
  q[i] /= length;
  q[i + 1] /= length;
  q[i + 2] /= length;
  q[i + 3] /= length;
}

/**
 * The matrix of a translation, a rotation and a scale (scale, then rotate,
 * then translate), column-major, written at `oi`.
 */
export function composeMatrix(
  t: Floats,
  ti: number,
  r: Floats,
  ri: number,
  s: Floats,
  si: number,
  out: Out,
  oi: number,
): void {
  const x = r[ri];
  const y = r[ri + 1];
  const z = r[ri + 2];
  const w = r[ri + 3];
  const sx = s[si];
  const sy = s[si + 1];
  const sz = s[si + 2];
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  out[oi] = (1 - 2 * (yy + zz)) * sx;
  out[oi + 1] = 2 * (xy + wz) * sx;
  out[oi + 2] = 2 * (xz - wy) * sx;
  out[oi + 3] = 0;
  out[oi + 4] = 2 * (xy - wz) * sy;
  out[oi + 5] = (1 - 2 * (xx + zz)) * sy;
  out[oi + 6] = 2 * (yz + wx) * sy;
  out[oi + 7] = 0;
  out[oi + 8] = 2 * (xz + wy) * sz;
  out[oi + 9] = 2 * (yz - wx) * sz;
  out[oi + 10] = (1 - 2 * (xx + yy)) * sz;
  out[oi + 11] = 0;
  out[oi + 12] = t[ti];
  out[oi + 13] = t[ti + 1];
  out[oi + 14] = t[ti + 2];
  out[oi + 15] = 1;
}

/** out = a × b, 4 × 4 column-major. `out` may not overlap `a` or `b`. */
export function multiplyMatrix(
  a: Floats,
  ai: number,
  b: Floats,
  bi: number,
  out: Out,
  oi: number,
): void {
  for (let column = 0; column < 4; column++) {
    const b0 = b[bi + column * 4];
    const b1 = b[bi + column * 4 + 1];
    const b2 = b[bi + column * 4 + 2];
    const b3 = b[bi + column * 4 + 3];
    for (let row = 0; row < 4; row++) {
      out[oi + column * 4 + row] =
        a[ai + row] * b0 +
        a[ai + 4 + row] * b1 +
        a[ai + 8 + row] * b2 +
        a[ai + 12 + row] * b3;
    }
  }
}
