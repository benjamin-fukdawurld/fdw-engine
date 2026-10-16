// Matrix operations on the columns of the scene: 4 × 4 column-major
// matrices stored at an offset of a Float32Array, written without
// allocation.

/**
 * out[o] = a[ao] × out[o]: the parent matrix applied to a local one, in
 * place. Affine matrices only (last row 0, 0, 0, 1).
 */
export function premultiplyAt(
  a: Float32Array,
  ao: number,
  out: Float32Array,
  o: number,
): void {
  const a00 = a[ao];
  const a01 = a[ao + 1];
  const a02 = a[ao + 2];
  const a10 = a[ao + 4];
  const a11 = a[ao + 5];
  const a12 = a[ao + 6];
  const a20 = a[ao + 8];
  const a21 = a[ao + 9];
  const a22 = a[ao + 10];
  const a30 = a[ao + 12];
  const a31 = a[ao + 13];
  const a32 = a[ao + 14];
  for (let column = 0; column < 4; column++) {
    const i = o + column * 4;
    const b0 = out[i];
    const b1 = out[i + 1];
    const b2 = out[i + 2];
    const b3 = out[i + 3];
    out[i] = a00 * b0 + a10 * b1 + a20 * b2 + a30 * b3;
    out[i + 1] = a01 * b0 + a11 * b1 + a21 * b2 + a31 * b3;
    out[i + 2] = a02 * b0 + a12 * b1 + a22 * b2 + a32 * b3;
  }
}

/**
 * The rotation of a world matrix as a unit quaternion (its scale removed),
 * for the cameras that follow a node.
 */
export function rotationOf(
  m: ArrayLike<number>,
  o = 0,
): { x: number; y: number; z: number; w: number } {
  const sx = Math.hypot(m[o], m[o + 1], m[o + 2]) || 1;
  const sy = Math.hypot(m[o + 4], m[o + 5], m[o + 6]) || 1;
  const sz = Math.hypot(m[o + 8], m[o + 9], m[o + 10]) || 1;
  const m00 = m[o] / sx;
  const m10 = m[o + 1] / sx;
  const m20 = m[o + 2] / sx;
  const m01 = m[o + 4] / sy;
  const m11 = m[o + 5] / sy;
  const m21 = m[o + 6] / sy;
  const m02 = m[o + 8] / sz;
  const m12 = m[o + 9] / sz;
  const m22 = m[o + 10] / sz;
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    return {
      w: 0.25 / s,
      x: (m21 - m12) * s,
      y: (m02 - m20) * s,
      z: (m10 - m01) * s,
    };
  }
  if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    return {
      w: (m21 - m12) / s,
      x: 0.25 * s,
      y: (m01 + m10) / s,
      z: (m02 + m20) / s,
    };
  }
  if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    return {
      w: (m02 - m20) / s,
      x: (m01 + m10) / s,
      y: 0.25 * s,
      z: (m12 + m21) / s,
    };
  }
  const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
  return {
    w: (m10 - m01) / s,
    x: (m02 + m20) / s,
    y: (m12 + m21) / s,
    z: 0.25 * s,
  };
}
