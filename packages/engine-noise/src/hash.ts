// Integer hashes of the PCG family (M. Jarzynski, M. Olano, "Hash
// Functions for GPU Rendering", JCGT 2020): the same 32-bit operations as
// the noise.pcg* functions of the material graph, so that the CPU and the
// GPU get the same bits. Unsigned products keep their low 32 bits
// (Math.imul), as u32 products do on the GPU.

/** A pseudo-random u32 from a u32: the PCG hash (RXS-M-XS). */
export function pcg(value: number): number {
  const state = (Math.imul(value >>> 0, 747796405) + 2891336453) >>> 0;
  const word = Math.imul(
    ((state >>> ((state >>> 28) + 4)) ^ state) >>> 0,
    277803737,
  );
  return ((word >>> 22) ^ word) >>> 0;
}

const lcg = (value: number) =>
  (Math.imul(value >>> 0, 1664525) + 1013904223) >>> 0;
const mulAdd = (a: number, b: number, c: number) => (a + Math.imul(b, c)) >>> 0;

/** Two pseudo-random u32 from two u32 (pcg2d), in `out`. */
export function pcg2d(x: number, y: number, out: number[] = [0, 0]): number[] {
  x = lcg(x);
  y = lcg(y);
  x = mulAdd(x, y, 1664525);
  y = mulAdd(y, x, 1664525);
  x = (x ^ (x >>> 16)) >>> 0;
  y = (y ^ (y >>> 16)) >>> 0;
  x = mulAdd(x, y, 1664525);
  y = mulAdd(y, x, 1664525);
  out[0] = (x ^ (x >>> 16)) >>> 0;
  out[1] = (y ^ (y >>> 16)) >>> 0;
  return out;
}

/** Three pseudo-random u32 from three u32 (pcg3d), in `out`. */
export function pcg3d(
  x: number,
  y: number,
  z: number,
  out: number[] = [0, 0, 0],
): number[] {
  x = lcg(x);
  y = lcg(y);
  z = lcg(z);
  x = mulAdd(x, y, z);
  y = mulAdd(y, z, x);
  z = mulAdd(z, x, y);
  x = (x ^ (x >>> 16)) >>> 0;
  y = (y ^ (y >>> 16)) >>> 0;
  z = (z ^ (z >>> 16)) >>> 0;
  x = mulAdd(x, y, z);
  y = mulAdd(y, z, x);
  z = mulAdd(z, x, y);
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}

/** Four pseudo-random u32 from four u32 (pcg4d), in `out`. */
export function pcg4d(
  x: number,
  y: number,
  z: number,
  w: number,
  out: number[] = [0, 0, 0, 0],
): number[] {
  x = lcg(x);
  y = lcg(y);
  z = lcg(z);
  w = lcg(w);
  x = mulAdd(x, y, w);
  y = mulAdd(y, z, x);
  z = mulAdd(z, x, y);
  w = mulAdd(w, y, z);
  x = (x ^ (x >>> 16)) >>> 0;
  y = (y ^ (y >>> 16)) >>> 0;
  z = (z ^ (z >>> 16)) >>> 0;
  w = (w ^ (w >>> 16)) >>> 0;
  x = mulAdd(x, y, w);
  y = mulAdd(y, z, x);
  z = mulAdd(z, x, y);
  w = mulAdd(w, y, z);
  out[0] = x;
  out[1] = y;
  out[2] = z;
  out[3] = w;
  return out;
}

/** A u32 to a float in [0, 1): its 24 high bits, exact in a f32. */
export const toUnit = (value: number): number => (value >>> 8) * (1 / 16777216);

// A coordinate of a cell (an integer as a float) to the bits of its i32.
const cellBits = (value: number) => (Math.floor(value) | 0) >>> 0;

/**
 * The hash of the integer cell of a point (the floor of its coordinates),
 * for a seed: 2 to 4 pseudo-random u32, as noise.hash2/3/4. The seed is
 * hashed and mixed into every coordinate first: each seed gives other
 * values, not shifted ones.
 */
export function hashCell(
  cell: ArrayLike<number>,
  seed = 0,
  out: number[] = [],
): number[] {
  const mix = pcg(seed);
  const key = (i: number) => (cellBits(cell[i]) ^ mix) >>> 0;
  switch (cell.length) {
    case 2:
      return pcg2d(key(0), key(1), out);
    case 3:
      return pcg3d(key(0), key(1), key(2), out);
    case 4:
      return pcg4d(key(0), key(1), key(2), key(3), out);
    default:
      throw new Error(`hashCell: 2 to 4 coordinates, got ${cell.length}`);
  }
}

/**
 * Random floats in [0, 1) for the integer cell of a point (2 to 4, one per
 * coordinate), as noise.random2/3/4: one value per tile, brick, cell…
 */
export function random(point: ArrayLike<number>, seed = 0): number[] {
  return hashCell(point, seed).map(toUnit);
}
