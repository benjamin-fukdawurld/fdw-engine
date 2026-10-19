import { hashCell, pcg, toUnit } from './hash';

// The noises of the material graph (noise.value2… noise.worley4), in
// TypeScript: the same algorithms, the same hashes, the same constants, in
// the same order of operations. The CPU computes in doubles, the GPU in
// floats: the values agree to about 1e-5 (tests compare them), except
// where a value jumps (the cell of a Worley noise, at equal distances).

/** The dimensions of the noises: 2 to 4 coordinates (the 4th one: time). */
export type NoisePoint = ArrayLike<number>;

const hash = [0, 0, 0, 0];
const cell = [0, 0, 0, 0];

// The quintic fade of Perlin's improved noise: t³ (t (6 t - 15) + 10).
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const mix = (a: number, b: number, t: number) => a * (1 - t) + b * t;

// The hash of the cell `base + corner` (corner: one bit per coordinate).
function cornerHash(
  base: NoisePoint,
  corner: number,
  seed: number,
  out: number[],
): number[] {
  const n = base.length;
  const key = cell.slice(0, n);
  for (let k = 0; k < n; k++) {
    key[k] = base[k] + ((corner >> k) & 1);
  }
  return hashCell(key, seed, out);
}

// Interpolates the 2^n corner values, along x, then y, z, w.
function interpolate(values: number[], u: readonly number[]): number {
  let count = values.length;
  for (let k = 0; k < u.length; k++) {
    count /= 2;
    for (let i = 0; i < count; i++) {
      values[i] = mix(values[2 * i], values[2 * i + 1], u[k]);
    }
  }
  return values[0];
}

function lattice(
  point: NoisePoint,
  seed: number,
  corner: (h: number[], t: readonly number[], corner: number) => number,
): number {
  const n = point.length;
  const base: number[] = [];
  const t: number[] = [];
  const u: number[] = [];
  for (let k = 0; k < n; k++) {
    base.push(Math.floor(point[k]));
    t.push(point[k] - base[k]);
    u.push(fade(t[k]));
  }
  // Corner c: bit k for coordinate k. Interpolated along x first: the
  // corners are ordered with x as the lowest bit.
  const values: number[] = [];
  for (let c = 0; c < 1 << n; c++) {
    values.push(corner(cornerHash(base, c, seed, hash), t, c));
  }
  return interpolate(values, u);
}

/**
 * Value noise in [-1, 1]: a random value at each integer point of the
 * lattice, interpolated by the quintic fade. As noise.value2/3/4.
 */
export function valueNoise(point: NoisePoint, seed = 0): number {
  return lattice(point, seed, (h) => toUnit(h[0]) * 2 - 1);
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

const g = [0, 0, 0, 0];

/** The scale of the gradient noise: its largest value, √n / 2, to 1. */
const perlinScale = (n: number) => 2 / Math.sqrt(n);

/**
 * Gradient noise (Perlin) in [-1, 1]: a random unit gradient at each
 * integer point of the lattice, interpolated by the quintic fade. As
 * noise.perlin2/3/4.
 */
export function perlinNoise(point: NoisePoint, seed = 0): number {
  const n = point.length;
  return (
    lattice(point, seed, (h, t, c) => {
      gradient(h, n, g);
      let dot = 0;
      for (let k = 0; k < n; k++) {
        dot += g[k] * (t[k] - ((c >> k) & 1));
      }
      return dot;
    }) * perlinScale(n)
  );
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

// The offsets of the corners of the simplex of x0 after the first one (the
// last one is (1, 1…)), as the rank comparisons of the shaders compute them.
function simplexCorners(x0: readonly number[]): number[][] {
  const n = x0.length;
  if (n === 2) {
    const x = step(x0[1], x0[0]);
    return [
      [x, 1 - x],
      [1, 1],
    ];
  }
  if (n === 3) {
    // g = step(x0.yzx, x0.xyz), l = 1 - g; i1 = min(g, l.zxy), i2 = max.
    const gv = [step(x0[1], x0[0]), step(x0[2], x0[1]), step(x0[0], x0[2])];
    const l = gv.map((v) => 1 - v);
    const lz = [l[2], l[0], l[1]];
    return [
      gv.map((v, k) => Math.min(v, lz[k])),
      gv.map((v, k) => Math.max(v, lz[k])),
      [1, 1, 1],
    ];
  }
  // The rank of each coordinate among the four (Gustavson, McEwan).
  const isX = [step(x0[1], x0[0]), step(x0[2], x0[0]), step(x0[3], x0[0])];
  const isYZ = [step(x0[2], x0[1]), step(x0[3], x0[1]), step(x0[3], x0[2])];
  const rank = [
    isX[0] + isX[1] + isX[2],
    1 - isX[0] + isYZ[0] + isYZ[1],
    1 - isX[1] + (1 - isYZ[0]) + isYZ[2],
    1 - isX[2] + (1 - isYZ[1]) + (1 - isYZ[2]),
  ];
  return [
    rank.map((r) => clamp01(r - 2)),
    rank.map((r) => clamp01(r - 1)),
    rank.map((r) => clamp01(r)),
    [1, 1, 1, 1],
  ];
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
  const base: number[] = [];
  let baseSum = 0;
  for (let k = 0; k < n; k++) {
    base.push(Math.floor(point[k] + s));
    baseSum += base[k];
  }
  const t = baseSum * unskew;
  const x0: number[] = [];
  for (let k = 0; k < n; k++) {
    x0.push(point[k] - base[k] + t);
  }
  const offsets = [new Array(n).fill(0), ...simplexCorners(x0)];
  let total = 0;
  offsets.forEach((offset, c) => {
    const x: number[] = [];
    const key: number[] = [];
    let squared = 0;
    for (let k = 0; k < n; k++) {
      x.push(x0[k] - offset[k] + c * unskew);
      key.push(base[k] + offset[k]);
      squared += x[k] * x[k];
    }
    const a = Math.max(r2 - squared, 0);
    gradient(hashCell(key, seed, hash), n, g);
    let dot = 0;
    for (let k = 0; k < n; k++) {
      dot += g[k] * x[k];
    }
    total += a * a * a * a * dot;
  });
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
  const n = point.length;
  const base: number[] = [];
  const f: number[] = [];
  for (let k = 0; k < n; k++) {
    base.push(Math.floor(point[k]));
    f.push(point[k] - base[k]);
  }
  let best1 = 1e10;
  let best2 = 1e10;
  let bestHash = 0;
  const key: number[] = new Array(n).fill(0);
  const count = 3 ** n;
  for (let i = 0; i < count; i++) {
    let squared = 0;
    let digits = i;
    const offset: number[] = [];
    for (let k = 0; k < n; k++) {
      offset.push((digits % 3) - 1);
      digits = Math.floor(digits / 3);
      key[k] = base[k] + offset[k];
    }
    hashCell(key, seed, hash);
    for (let k = 0; k < n; k++) {
      const feature = offset[k] + 0.5 + jitter * (toUnit(hash[k]) - 0.5);
      const d = feature - f[k];
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
  const id = pcg(bestHash);
  return {
    f1: Math.sqrt(best1),
    f2: Math.sqrt(best2),
    id,
    random: toUnit(id),
  };
}
