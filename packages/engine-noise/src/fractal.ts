import {
  NoisePoint,
  perlinNoise,
  simplexNoise,
  valueNoise,
  worleyNoise,
} from './noise';

/** The noises a fractal sum can add up. */
export type NoiseKind = 'value' | 'perlin' | 'simplex' | 'worley';

/** A noise by its kind: in [-1, 1], the distance F1 for Worley. */
export function noise(kind: NoiseKind, point: NoisePoint, seed = 0): number {
  switch (kind) {
    case 'value':
      return valueNoise(point, seed);
    case 'perlin':
      return perlinNoise(point, seed);
    case 'simplex':
      return simplexNoise(point, seed);
    case 'worley':
      return worleyNoise(point, seed).f1;
  }
}

/** The octaves of a fractal sum, as noise.fbm and the others take them. */
export interface FractalOptions {
  /** The noise added up. Default 'perlin'. */
  readonly noise?: NoiseKind;
  /** The number of octaves. Default 5. */
  readonly octaves?: number;
  /** How much the frequency grows from an octave to the next. Default 2. */
  readonly lacunarity?: number;
  /** How much the amplitude shrinks from an octave to the next. Default 0.5. */
  readonly gain?: number;
  /** The seed of the first octave; octave i takes seed + i. Default 0. */
  readonly seed?: number;
  /**
   * The size of a pixel in the units of the point: the octaves finer than
   * two pixels fade out (to their average). Default 0: none.
   */
  readonly footprint?: number;
}

/**
 * The average values the octaves fade to when they are finer than the
 * pixel: 0 for fbm, about that of each term for ridged and turbulence
 * (measured on the gradient noise). The same in the material graph.
 */
export const fadedOctaveAverages = {
  fbm: 0,
  ridged: 0.65,
  turbulence: 0.2,
} as const;

/** The kinds of fractal sums. */
export type FractalKind = keyof typeof fadedOctaveAverages;

// What an octave adds: the noise, folded for the ridged and turbulent sums.
const terms: Record<FractalKind, (n: number) => number> = {
  fbm: (n) => n,
  ridged: (n) => (1 - Math.abs(n)) * (1 - Math.abs(n)),
  turbulence: (n) => Math.abs(n),
};

/**
 * The weight of an octave of a frequency for a footprint: 1 while its
 * period spans more than four pixels, 0 under two.
 */
export function octaveWeight(footprint: number, frequency: number): number {
  const x = footprint * frequency;
  const t = Math.min(Math.max((x - 0.25) / 0.25, 0), 1);
  return 1 - t * t * (3 - 2 * t);
}

/**
 * A fractal sum of a noise: the octaves (the noise at growing frequencies
 * and shrinking amplitudes) added up, divided by the sum of the
 * amplitudes. `fbm` (fractional Brownian motion) in [-1, 1]; `ridged`,
 * 1 - |noise| squared, sharp crests, in [0, 1]; `turbulence`, |noise|,
 * creases, in [0, 1]. As noise.fbm, noise.ridged and noise.turbulence.
 */
export function fractal(
  kind: FractalKind,
  point: NoisePoint,
  {
    noise: noiseKind = 'perlin',
    octaves = 5,
    lacunarity = 2,
    gain = 0.5,
    seed = 0,
    footprint = 0,
  }: FractalOptions = {},
): number {
  const term = terms[kind];
  const average = fadedOctaveAverages[kind];
  const scaled = new Array<number>(point.length);
  let sum = 0;
  let amplitude = 1;
  let frequency = 1;
  let total = 0;
  for (let octave = 0; octave < octaves; octave++) {
    for (let k = 0; k < point.length; k++) {
      scaled[k] = point[k] * frequency;
    }
    const value = term(noise(noiseKind, scaled, (seed + octave) >>> 0));
    const weight = footprint > 0 ? octaveWeight(footprint, frequency) : 1;
    sum += amplitude * (value * weight + average * (1 - weight));
    total += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return sum / total;
}

/** Fractional Brownian motion: see {@link fractal}. */
export const fbm = (point: NoisePoint, options?: FractalOptions) =>
  fractal('fbm', point, options);

/** The ridged sum: see {@link fractal}. */
export const ridged = (point: NoisePoint, options?: FractalOptions) =>
  fractal('ridged', point, options);

/** The turbulence: see {@link fractal}. */
export const turbulence = (point: NoisePoint, options?: FractalOptions) =>
  fractal('turbulence', point, options);

/** The seed offsets of the components of a domain warp. */
export const warpSeeds = [1013, 2026, 3039, 4052] as const;

/**
 * Domain warping: the point moved by a fbm per coordinate (each its own
 * seed: seed + 1013, + 2026…), times `strength`. Noises read at the warped
 * point swirl and stretch. As noise.warp.
 */
export function warp(
  point: NoisePoint,
  { strength = 1, ...options }: FractalOptions & { strength?: number } = {},
): number[] {
  const seed = options.seed ?? 0;
  return Array.from(
    { length: point.length },
    (_, k) =>
      point[k] +
      strength * fbm(point, { ...options, seed: (seed + warpSeeds[k]) >>> 0 }),
  );
}
