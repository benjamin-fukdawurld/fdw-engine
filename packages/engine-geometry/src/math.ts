// The small vector and matrix operations of the volumes. Vectors are
// [x, y, z] arrays; matrices are 4 × 4, column-major (element (row, column)
// at column * 4 + row), as in the rest of the engine.

/** A point or a direction: [x, y, z]. */
export type Vec3 = [number, number, number];
export type ReadonlyVec3 = readonly [number, number, number];

/** A 4 × 4 matrix, column-major: a Float32Array, or any array of 16 numbers. */
export type Matrix4 = ArrayLike<number>;

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => [x, y, z];

export const dot = (a: ReadonlyVec3, b: ReadonlyVec3): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export const length = (a: ReadonlyVec3): number =>
  Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);

export function set(out: Vec3, x: number, y: number, z: number): Vec3 {
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}

export function copy(out: Vec3, a: ReadonlyVec3): Vec3 {
  return set(out, a[0], a[1], a[2]);
}

export function add(out: Vec3, a: ReadonlyVec3, b: ReadonlyVec3): Vec3 {
  return set(out, a[0] + b[0], a[1] + b[1], a[2] + b[2]);
}

export function sub(out: Vec3, a: ReadonlyVec3, b: ReadonlyVec3): Vec3 {
  return set(out, a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function scale(out: Vec3, a: ReadonlyVec3, factor: number): Vec3 {
  return set(out, a[0] * factor, a[1] * factor, a[2] * factor);
}

/** out = a + b × factor. */
export function scaleAndAdd(
  out: Vec3,
  a: ReadonlyVec3,
  b: ReadonlyVec3,
  factor: number,
): Vec3 {
  return set(
    out,
    a[0] + b[0] * factor,
    a[1] + b[1] * factor,
    a[2] + b[2] * factor,
  );
}

export function cross(out: Vec3, a: ReadonlyVec3, b: ReadonlyVec3): Vec3 {
  return set(
    out,
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  );
}

/** a / |a|, or a unchanged when it has no length. */
export function normalize(out: Vec3, a: ReadonlyVec3): Vec3 {
  const l = length(a);
  return l > 0 ? scale(out, a, 1 / l) : copy(out, a);
}

/** The point transformed by the matrix (w = 1). */
export function transformPoint(
  out: Vec3,
  m: Matrix4,
  [x, y, z]: ReadonlyVec3,
): Vec3 {
  return set(
    out,
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  );
}

/** The direction transformed by the matrix (w = 0): no translation. */
export function transformDirection(
  out: Vec3,
  m: Matrix4,
  [x, y, z]: ReadonlyVec3,
): Vec3 {
  return set(
    out,
    m[0] * x + m[4] * y + m[8] * z,
    m[1] * x + m[5] * y + m[9] * z,
    m[2] * x + m[6] * y + m[10] * z,
  );
}

/** The largest scale of a matrix: the longest of its three first columns. */
export function maxScale(m: Matrix4): number {
  return Math.sqrt(
    Math.max(
      m[0] * m[0] + m[1] * m[1] + m[2] * m[2],
      m[4] * m[4] + m[5] * m[5] + m[6] * m[6],
      m[8] * m[8] + m[9] * m[9] + m[10] * m[10],
    ),
  );
}

/** The inverse of a matrix, or undefined when it has none. */
export function invert(m: Matrix4): Float64Array | undefined {
  const [a00, a01, a02, a03, a10, a11, a12, a13] = [
    m[0],
    m[1],
    m[2],
    m[3],
    m[4],
    m[5],
    m[6],
    m[7],
  ];
  const [a20, a21, a22, a23, a30, a31, a32, a33] = [
    m[8],
    m[9],
    m[10],
    m[11],
    m[12],
    m[13],
    m[14],
    m[15],
  ];
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const determinant =
    b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (determinant === 0) {
    return undefined;
  }
  const inverse = 1 / determinant;
  return Float64Array.of(
    (a11 * b11 - a12 * b10 + a13 * b09) * inverse,
    (a02 * b10 - a01 * b11 - a03 * b09) * inverse,
    (a31 * b05 - a32 * b04 + a33 * b03) * inverse,
    (a22 * b04 - a21 * b05 - a23 * b03) * inverse,
    (a12 * b08 - a10 * b11 - a13 * b07) * inverse,
    (a00 * b11 - a02 * b08 + a03 * b07) * inverse,
    (a32 * b02 - a30 * b05 - a33 * b01) * inverse,
    (a20 * b05 - a22 * b02 + a23 * b01) * inverse,
    (a10 * b10 - a11 * b08 + a13 * b06) * inverse,
    (a01 * b08 - a00 * b10 - a03 * b06) * inverse,
    (a30 * b04 - a31 * b02 + a33 * b00) * inverse,
    (a21 * b02 - a20 * b04 - a23 * b00) * inverse,
    (a11 * b07 - a10 * b09 - a12 * b06) * inverse,
    (a00 * b09 - a01 * b07 + a02 * b06) * inverse,
    (a31 * b01 - a30 * b03 - a32 * b00) * inverse,
    (a20 * b03 - a21 * b01 + a22 * b00) * inverse,
  );
}
