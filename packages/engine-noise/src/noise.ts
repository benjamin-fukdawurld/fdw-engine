import { hashCellBits, pcg, toUnit } from './hash';

// The noises of the material graph (noise.value2… noise.worley4), in
// TypeScript: the same algorithms, the same hashes, the same constants, in
// the same order of operations. The CPU computes in doubles, the GPU in
// floats: the values agree to about 1e-5 (tests compare them), except
// where a value jumps (the cell of a Worley noise, at equal distances).

/** The dimensions of the noises: 2 to 4 coordinates (the 4th one: time). */
export type NoisePoint = ArrayLike<number>;

// The scratch values of the noises, reused: a call allocates nothing (the
// noises run per texel of heightmaps and textures). Not reentrant, as
// nothing they call calls back.
const hash = [0, 0, 0, 0];
const g = [0, 0, 0, 0];
const base = new Float64Array(4);
const t = new Float64Array(4);
const u = new Float64Array(4);
const key = new Float64Array(4);
// The values of the 2^n corners of a lattice cell.
const values = new Float64Array(16);
// The offsets of the n + 1 corners of a simplex, 4 numbers a corner.
const offsets = new Float64Array(20);

// The quintic fade of Perlin's improved noise: t³ (t (6 t - 15) + 10).
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const mix = (a: number, b: number, t: number) => a * (1 - t) + b * t;

// Interpolates the 2^n corner values, along x, then y, z, w.
function interpolate(n: number): number {
  let count = 1 << n;
  for (let k = 0; k < n; k++) {
    count /= 2;
    for (let i = 0; i < count; i++) {
      values[i] = mix(values[2 * i], values[2 * i + 1], u[k]);
    }
  }
  return values[0];
}

// The noises on a lattice: the value of each corner, interpolated.
const Value = 0;
const Gradient = 1;

function lattice(
  point: NoisePoint,
  seed: number,
  kind: typeof Value | typeof Gradient,
): number {
  const n = point.length;
  for (let k = 0; k < n; k++) {
    base[k] = Math.floor(point[k]);
    t[k] = point[k] - base[k];
    u[k] = fade(t[k]);
  }
  const seedMix = pcg(seed);
  // Corner c: bit k for coordinate k. Interpolated along x first: the
  // corners are ordered with x as the lowest bit.
  for (let c = 0; c < 1 << n; c++) {
    for (let k = 0; k < n; k++) {
      key[k] = base[k] + ((c >> k) & 1);
    }
    const h = hashCellBits(key, n, seedMix, hash);
    if (kind === Value) {
      values[c] = toUnit(h[0]) * 2 - 1;
      continue;
    }
    gradient(h, n, g);
    let dot = 0;
    for (let k = 0; k < n; k++) {
      dot += g[k] * (t[k] - ((c >> k) & 1));
    }
    values[c] = dot;
  }
  return interpolate(n);
}

/**
 * Value noise in [-1, 1]: a random value at each integer point of the
 * lattice, interpolated by the quintic fade. As noise.value2/3/4.
 */
export function valueNoise(point: NoisePoint, seed = 0): number {
  return lattice(point, seed, Value);
}

// A random unit vector from a hash: the components in [-1, 1), normalized.
function gradient(h: readonly number[], n: number, out: number[]): number[] {
  let squared = 0;
  for (let k = 0; k < n; k++) {
    out[k] = toUnit(h[k]) * 2 - 1;
    squared += out[k] * out[k];
  }
  const length = Math.sqrt(Math.max(squared, 1e-12));
  for (let k = 0; k < n; k++) {
    out[k] /= length;
  }
  return out;
}

/** The scale of the gradient noise: its largest value, √n / 2, to 1. */
const perlinScale = (n: number) => 2 / Math.sqrt(n);

/**
 * Gradient noise (Perlin) in [-1, 1]: a random unit gradient at each
 * integer point of the lattice, interpolated by the quintic fade. As
 * noise.perlin2/3/4.
 */
export function perlinNoise(point: NoisePoint, seed = 0): number {
  return lattice(point, seed, Gradient) * perlinScale(point.length);
}

// The skew and unskew factors of the simplex lattices, by dimension.
const skew = {
  2: { f: (Math.sqrt(3) - 1) / 2, g: (3 - Math.sqrt(3)) / 6, r2: 0.5 },
  3: { f: 1 / 3, g: 1 / 6, r2: 0.5 },
  4: { f: (Math.sqrt(5) - 1) / 4, g: (5 - Math.sqrt(5)) / 20, r2: 0.5 },
} as const;

/**
 * The scales of the simplex noises: their largest values (measured) to 1.
 * The same in the material graph.
 */
export const simplexScales = { 2: 99, 3: 108, 4: 109 } as const;

// step(edge, x) of the shading languages: 0 when x < edge, 1 otherwise.
const step = (edge: number, x: number) => (x < edge ? 0 : 1);
const clamp01 = (x: number) => Math.min(Math.max(x, 0), 1);

// The offsets of the corners of the simplex of x0 (in `t`), into
// `offsets`: the first one 0, the last one (1, 1…), those between as the
// rank comparisons of the shaders compute them.
function simplexCorners(n: 2 | 3 | 4): void {
  const x0 = t;
  offsets.fill(0, 0, 4);
  offsets.fill(1, n * 4, n * 4 + 4);
  if (n === 2) {
    const x = step(x0[1], x0[0]);
    offsets[4] = x;
    offsets[5] = 1 - x;
    return;
  }
  if (n === 3) {
    // g = step(x0.yzx, x0.xyz), l = 1 - g; i1 = min(g, l.zxy), i2 = max.
    const g0 = step(x0[1], x0[0]);
    const g1 = step(x0[2], x0[1]);
    const g2 = step(x0[0], x0[2]);
    const lz0 = 1 - g2;
    const lz1 = 1 - g0;
    const lz2 = 1 - g1;
    offsets[4] = Math.min(g0, lz0);
    offsets[5] = Math.min(g1, lz1);
    offsets[6] = Math.min(g2, lz2);
    offsets[8] = Math.max(g0, lz0);
    offsets[9] = Math.max(g1, lz1);
    offsets[10] = Math.max(g2, lz2);
    return;
  }
  // The rank of each coordinate among the four (Gustavson, McEwan).
  const x1 = step(x0[1], x0[0]);
  const x2 = step(x0[2], x0[0]);
  const x3 = step(x0[3], x0[0]);
  const yz0 = step(x0[2], x0[1]);
  const yz1 = step(x0[3], x0[1]);
  const yz2 = step(x0[3], x0[2]);
  rankOffsets(0, x1 + x2 + x3);
  rankOffsets(1, 1 - x1 + yz0 + yz1);
  rankOffsets(2, 1 - x2 + (1 - yz0) + yz2);
  rankOffsets(3, 1 - x3 + (1 - yz1) + (1 - yz2));
}

// The offsets of coordinate k in the 3 corners between, from its rank.
function rankOffsets(k: number, rank: number): void {
  offsets[4 + k] = clamp01(rank - 2);
  offsets[8 + k] = clamp01(rank - 1);
  offsets[12 + k] = clamp01(rank);
}

/**
 * Simplex noise in [-1, 1] (Perlin 2001, after Gustavson): the gradients
 * of the n + 1 corners of the simplex of the point, each fading out with
 * the distance, unit gradients from the hash. Cheaper than the gradient
 * noise in 3 and 4 dimensions, without its axis-aligned artifacts. As
 * noise.simplex2/3/4.
 */
export function simplexNoise(point: NoisePoint, seed = 0): number {
  const n = point.length as 2 | 3 | 4;
  const { f, g: unskew, r2 } = skew[n];
  let sum = 0;
  for (let k = 0; k < n; k++) {
    sum += point[k];
  }
  const s = sum * f;
  let baseSum = 0;
  for (let k = 0; k < n; k++) {
    base[k] = Math.floor(point[k] + s);
    baseSum += base[k];
  }
  const shift = baseSum * unskew;
  // x0, the point from the first corner, in t.
  for (let k = 0; k < n; k++) {
    t[k] = point[k] - base[k] + shift;
  }
  simplexCorners(n);
  const seedMix = pcg(seed);
  let total = 0;
  for (let c = 0; c <= n; c++) {
    // x, the point from corner c, in u.
    let squared = 0;
    for (let k = 0; k < n; k++) {
      const offset = offsets[c * 4 + k];
      u[k] = t[k] - offset + c * unskew;
      key[k] = base[k] + offset;
      squared += u[k] * u[k];
    }
    const a = Math.max(r2 - squared, 0);
    gradient(hashCellBits(key, n, seedMix, hash), n, g);
    let dot = 0;
    for (let k = 0; k < n; k++) {
      dot += g[k] * u[k];
    }
    total += a * a * a * a * dot;
  }
  return total * simplexScales[n];
}

/** The distances and the cell of a cellular noise at a point. */
export interface WorleyValue {
  /** The distance to the nearest feature point, and to the second one. */
  f1: number;
  f2: number;
  /** The identifier of the cell of the nearest point: a u32. */
  id: number;
  /** A random float in [0, 1) for that cell, from its identifier. */
  random: number;
}

/**
 * Cellular noise (Worley 1996): a feature point in each cell of the
 * lattice, at a random place (`jitter` 1) or at its center (0); the
 * distances from the point to the nearest feature point and the second
 * one, and the cell of the nearest (Voronoi). The 3^n cells around are
 * searched, x varying the fastest. As noise.worley2/3/4.
 */
export function worleyNoise(
  point: NoisePoint,
  seed = 0,
  jitter = 1,
): WorleyValue {
  worley(point, seed, jitter);
  const id = pcg(bestHash);
  return {
    f1: Math.sqrt(best1),
    f2: Math.sqrt(best2),
    id,
    random: toUnit(id),
  };
}

/**
 * The distance F1 of {@link worleyNoise}, without its other values: what
 * the fractal sums add up, allocating nothing.
 *
 * @internal
 */
export function worleyF1(point: NoisePoint, seed = 0, jitter = 1): number {
  worley(point, seed, jitter);
  return Math.sqrt(best1);
}

// The squared distances to the two nearest feature points, and the hash
// of the cell of the nearest: the result of worley().
let best1 = 0;
let best2 = 0;
let bestHash = 0;
// The offset of the cell searched, in -1…1 per coordinate.
const offset = new Float64Array(4);

function worley(point: NoisePoint, seed: number, jitter: number): void {
  const n = point.length;
  // The point in its cell, in t.
  for (let k = 0; k < n; k++) {
    base[k] = Math.floor(point[k]);
    t[k] = point[k] - base[k];
  }
  const seedMix = pcg(seed);
  best1 = 1e10;
  best2 = 1e10;
  bestHash = 0;
  const count = 3 ** n;
  for (let i = 0; i < count; i++) {
    let squared = 0;
    let digits = i;
    for (let k = 0; k < n; k++) {
      offset[k] = (digits % 3) - 1;
      digits = Math.floor(digits / 3);
      key[k] = base[k] + offset[k];
    }
    hashCellBits(key, n, seedMix, hash);
    for (let k = 0; k < n; k++) {
      const feature = offset[k] + 0.5 + jitter * (toUnit(hash[k]) - 0.5);
      const d = feature - t[k];
      squared += d * d;
    }
    if (squared < best1) {
      best2 = best1;
      best1 = squared;
      bestHash = hash[0];
    } else {
      best2 = Math.min(best2, squared);
    }
  }
}
