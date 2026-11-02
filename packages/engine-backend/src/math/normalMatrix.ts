/**
 * Writes the normal matrix of a 4 × 4 column-major matrix: the inverse
 * transpose of its 3 × 3 part, as 3 columns of 4 floats (the layout of WGSL
 * and std140), the 4th float of each column 0. A singular matrix (a scale
 * of 0) gives a zero matrix rather than infinities.
 */
export function writeNormalMatrix(
  source: ArrayLike<number>,
  sourceOffset: number,
  out: Float32Array,
  outOffset: number,
): void {
  const a00 = source[sourceOffset];
  const a01 = source[sourceOffset + 1];
  const a02 = source[sourceOffset + 2];
  const a10 = source[sourceOffset + 4];
  const a11 = source[sourceOffset + 5];
  const a12 = source[sourceOffset + 6];
  const a20 = source[sourceOffset + 8];
  const a21 = source[sourceOffset + 9];
  const a22 = source[sourceOffset + 10];
  // The names are column then row: a01 is column 0, row 1. With B the
  // matrix whose (i, j) is aij, the 3 × 3 part is Bᵀ, and its inverse
  // transpose is cofactors(B)ᵀ / determinant: column c holds the cofactors
  // of row c of B.
  const c00 = a11 * a22 - a12 * a21;
  const c01 = a12 * a20 - a10 * a22;
  const c02 = a10 * a21 - a11 * a20;
  const c10 = a02 * a21 - a01 * a22;
  const c11 = a00 * a22 - a02 * a20;
  const c12 = a01 * a20 - a00 * a21;
  const c20 = a01 * a12 - a02 * a11;
  const c21 = a02 * a10 - a00 * a12;
  const c22 = a00 * a11 - a01 * a10;
  const determinant = a00 * c00 + a01 * c01 + a02 * c02;
  const inverse = determinant !== 0 ? 1 / determinant : 0;
  const o = outOffset;
  out[o] = c00 * inverse;
  out[o + 1] = c01 * inverse;
  out[o + 2] = c02 * inverse;
  out[o + 3] = 0;
  out[o + 4] = c10 * inverse;
  out[o + 5] = c11 * inverse;
  out[o + 6] = c12 * inverse;
  out[o + 7] = 0;
  out[o + 8] = c20 * inverse;
  out[o + 9] = c21 * inverse;
  out[o + 10] = c22 * inverse;
  out[o + 11] = 0;
}
