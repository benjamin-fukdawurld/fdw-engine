// The ocean spectrum of Tessendorf: the sea as a sum of waves of every
// length and direction, of random phases and of amplitudes given by an
// oceanographic spectrum (JONSWAP, or Phillips), computed once on the CPU.
// The waves of each cascade (a tile of the sea, of its own size) are those
// of a band of wave numbers: together the cascades cover the waves from
// hundreds of meters to a few centimeters, without the repetition of a
// single tile.

/** The oceanographic spectra: how the energy of the sea spreads over the wave lengths. */
export type SpectrumModel = 'jonswap' | 'phillips';

/** The sea of an {@link OceanSpectrum}. */
export interface SpectrumOptions {
  /**
   * `jonswap` (the default): a sea built by the wind over a fetch, its
   * energy peaked around a wave length; `phillips`: a fully developed sea,
   * Tessendorf's original spectrum.
   */
  readonly model?: SpectrumModel;
  /** The speed of the wind, 10 m above the sea, in m/s (8). */
  readonly windSpeed?: number;
  /** The direction the wind blows to, in radians from +x toward +z (0). */
  readonly windDirection?: number;
  /** JONSWAP: how far the wind has blown over the sea, in meters (100 km). */
  readonly fetch?: number;
  /** JONSWAP: the peak enhancement γ, how narrow the peak is (3.3). */
  readonly peakEnhancement?: number;
  /**
   * How much the waves keep to the direction of the wind: the s of the
   * spreading cos^2s(θ/2) (8). Higher: more parallel crests.
   */
  readonly spread?: number;
  /** Multiplies the heights (1). */
  readonly scale?: number;
  /**
   * The sides of the tiles of the cascades, in meters, from the largest
   * ([233, 37.7, 6.3]). Sides that do not divide one another hide the
   * repetition.
   */
  readonly cascades?: readonly number[];
  /** The points along a side of a tile: a power of 2 (128). */
  readonly resolution?: number;
  /** The depth of the sea, for the speed of the waves (deep: Infinity). */
  readonly depth?: number;
  /**
   * The animation loops over this period, in seconds (200): the
   * frequencies are rounded to its multiples, the phases stay exact.
   */
  readonly period?: number;
  /** The random phases and amplitudes come from this seed (1). */
  readonly seed?: number;
  readonly gravity?: number;
}

/** The waves of the cascades, ready for the GPU and the CPU. */
export interface SpectrumData {
  readonly resolution: number;
  /** The sides of the tiles, in meters. */
  readonly cascades: readonly number[];
  readonly period: number;
  /**
   * Per wave (cascade, row along z, column along x): h0(k) and
   * conj(h0(-k)), (re, im, re, im).
   */
  readonly amplitudes: Float32Array<ArrayBuffer>;
  /** Per wave: kx, kz, the angular frequency ω, 1/|k| (0 for k = 0). */
  readonly waves: Float32Array<ArrayBuffer>;
  /** The standard deviation of the height of the sea, in meters. */
  readonly heightDeviation: number;
  /**
   * The variance of the slopes of each cascade, (∂h/∂x)² + (∂h/∂z)²: how
   * much rougher the water looks where the cascade is too fine to draw.
   */
  readonly slopeVariances: readonly number[];
}

/** The defaults of {@link SpectrumOptions}. */
export const defaultSpectrum = {
  model: 'jonswap',
  windSpeed: 8,
  windDirection: 0,
  fetch: 100_000,
  peakEnhancement: 3.3,
  spread: 8,
  scale: 1,
  cascades: [233, 37.7, 6.3],
  resolution: 128,
  depth: Infinity,
  period: 200,
  seed: 1,
  gravity: 9.81,
} as const satisfies Required<SpectrumOptions>;

// The waves of a cascade shorter than its band are left to the next one:
// the band of cascade c ends at 4 waves along the side of the next tile.
const bandEnd = (side: number) => (2 * Math.PI * 4) / side;

// A generator of floats in [0, 1) (mulberry32): the same sea for a seed.
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The energy of the sea per unit of wave vector, at (kx, kz), in m⁴: the
 * variance of the heights is its integral over the wave vectors.
 */
export function spectrumDensity(
  kx: number,
  kz: number,
  options: SpectrumOptions = {},
): number {
  const o = { ...defaultSpectrum, ...options };
  const k = Math.hypot(kx, kz);
  if (k === 0) {
    return 0;
  }
  const g = o.gravity;
  const angle = Math.atan2(kz, kx) - o.windDirection;
  if (o.model === 'phillips') {
    // A e^(-1/(kL)²) / k⁴ |k̂·ŵ|², L = U²/g the longest wave of the wind,
    // the waves against the wind removed, the shortest damped.
    const L = (o.windSpeed * o.windSpeed) / g;
    const along = Math.cos(angle);
    if (along <= 0) {
      return 0;
    }
    const small = L / 1000;
    return (
      ((0.0081 / Math.PI) *
        Math.exp(-1 / (k * L * k * L)) *
        along *
        along *
        Math.exp(-k * k * small * small)) /
      (k * k * k * k)
    );
  }
  // JONSWAP in frequency, S(ω) = α g² / ω⁵ e^(-5/4 (ωp/ω)⁴) γ^r, turned into
  // wave numbers (dω/dk / k) and spread around the wind.
  const omega = Math.sqrt(g * k * Math.tanh(Math.min(k * o.depth, 20)));
  const dimensionless = (o.windSpeed * o.windSpeed) / (o.fetch * g);
  const alpha = 0.076 * Math.pow(dimensionless, 0.22);
  const peak = 22 * Math.cbrt((g * g) / (o.windSpeed * o.fetch));
  const sigma = omega <= peak ? 0.07 : 0.09;
  const r = Math.exp(
    -((omega - peak) * (omega - peak)) / (2 * sigma * sigma * peak * peak),
  );
  const frequency =
    ((alpha * g * g) / Math.pow(omega, 5)) *
    Math.exp(-1.25 * Math.pow(peak / omega, 4)) *
    Math.pow(o.peakEnhancement, r);
  // dω/dk, deep water: g / 2ω.
  const slope = g / (2 * omega);
  return (frequency * slope * spreading(angle, o.spread)) / k;
}

// cos^2s(θ/2), normalized over the circle (the integral of its powers).
const spreadNorms = new Map<number, number>();
function spreading(angle: number, s: number): number {
  let norm = spreadNorms.get(s);
  if (norm === undefined) {
    let sum = 0;
    const steps = 2048;
    for (let i = 0; i < steps; i++) {
      const theta = ((i + 0.5) / steps) * 2 * Math.PI - Math.PI;
      sum += Math.pow(Math.abs(Math.cos(theta / 2)), 2 * s);
    }
    norm = 1 / ((sum * 2 * Math.PI) / steps);
    spreadNorms.set(s, norm);
  }
  return norm * Math.pow(Math.abs(Math.cos(angle / 2)), 2 * s);
}

/**
 * The waves of the cascades: wave vectors, frequencies and random complex
 * amplitudes h0(k) of variance S(k) Δk² / 2, such that the heights have
 * the variance of the spectrum.
 */
export function createSpectrum(options: SpectrumOptions = {}): SpectrumData {
  const o = { ...defaultSpectrum, ...options };
  const n = o.resolution;
  if (!Number.isInteger(Math.log2(n)) || n < 4) {
    throw new Error(`The resolution needs a power of 2, not ${n}`);
  }
  const cascades = [...o.cascades];
  if (cascades.length === 0 || cascades.some((side) => !(side > 0))) {
    throw new Error('The cascades need positive sides');
  }
  for (let c = 0; c + 1 < cascades.length; c++) {
    // The band of a cascade must end below its shortest wave.
    if (bandEnd(cascades[c + 1]) >= (Math.PI * n) / cascades[c]) {
      throw new Error(
        `The tile of ${cascades[c + 1]} m is too small after the one of ${cascades[c]} m for ${n} points`,
      );
    }
  }
  const next = random(o.seed);
  const gaussian = () => {
    // Box-Muller.
    const u = Math.max(next(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
  };
  const count = cascades.length * n * n;
  const amplitudes = new Float32Array(count * 4);
  const waves = new Float32Array(count * 4);
  const base = (2 * Math.PI) / o.period;
  let variance = 0;
  const slopeVariances: number[] = [];
  cascades.forEach((side, c) => {
    let slopes = 0;
    const dk = (2 * Math.PI) / side;
    const low = c === 0 ? 0 : bandEnd(side);
    const high = c + 1 < cascades.length ? bandEnd(cascades[c + 1]) : Infinity;
    // h0 of each wave vector of the band, then conj(h0(-k)) next to it.
    const h0 = new Float64Array(n * n * 2);
    for (let row = 0; row < n; row++) {
      for (let column = 0; column < n; column++) {
        const kx = (column - n / 2) * dk;
        const kz = (row - n / 2) * dk;
        const k = Math.hypot(kx, kz);
        const i = (c * n + row) * n + column;
        const omega =
          k > 0
            ? Math.sqrt(o.gravity * k * Math.tanh(Math.min(k * o.depth, 20)))
            : 0;
        waves.set(
          [kx, kz, Math.floor(omega / base) * base, k > 0 ? 1 / k : 0],
          i * 4,
        );
        // The random numbers are drawn for every wave, kept or not: a
        // cascade keeps its sea when another one changes.
        const xr = gaussian();
        const xi = gaussian();
        // Not the first row and column, the waves at the Nyquist frequency:
        // their opposite is themselves, which would leave imaginary parts
        // in the fields packed by two (see the GPU).
        if (row > 0 && column > 0 && k >= low && k < high) {
          const density = spectrumDensity(kx, kz, o) * o.scale * o.scale;
          const amplitude = Math.sqrt((density * dk * dk) / 2);
          h0[(row * n + column) * 2] = (xr / Math.SQRT2) * amplitude;
          h0[(row * n + column) * 2 + 1] = (xi / Math.SQRT2) * amplitude;
          variance += density * dk * dk;
          slopes += k * k * density * dk * dk;
        }
      }
    }
    slopeVariances.push(slopes);
    for (let row = 0; row < n; row++) {
      for (let column = 0; column < n; column++) {
        const opposite = (((n - row) % n) * n + ((n - column) % n)) * 2;
        const i = (c * n + row) * n + column;
        amplitudes.set(
          [
            h0[(row * n + column) * 2],
            h0[(row * n + column) * 2 + 1],
            h0[opposite],
            -h0[opposite + 1],
          ],
          i * 4,
        );
      }
    }
  });
  return {
    resolution: n,
    cascades,
    period: o.period,
    amplitudes,
    waves,
    heightDeviation: Math.sqrt(variance),
    slopeVariances,
  };
}
