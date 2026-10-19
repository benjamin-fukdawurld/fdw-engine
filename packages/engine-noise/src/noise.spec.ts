import { describe, expect, it } from 'vitest';
import {
  fbm,
  hashCell,
  octaveWeight,
  pcg,
  pcg2d,
  pcg3d,
  pcg4d,
  perlinNoise,
  random,
  ridged,
  simplexNoise,
  toUnit,
  turbulence,
  valueNoise,
  warp,
  worleyNoise,
} from './index';

// Points spread over a few cells, negative coordinates included.
const points = (dimension: number, count = 2000) => {
  let state = 1;
  const next = () => {
    state = pcg(state);
    return toUnit(state) * 40 - 20;
  };
  return Array.from({ length: count }, () =>
    Array.from({ length: dimension }, next),
  );
};

describe('hashes', () => {
  it('gives the bits of the reference implementation in C', () => {
    expect([pcg(0), pcg(1), pcg(4294967295)]).toEqual([
      129708002, 2831084092, 3861530882,
    ]);
    expect(pcg2d(1, 2)).toEqual([45825804, 214070181]);
    expect(pcg3d(1, 2, 3)).toEqual([4204755366, 1223881804, 1500469937]);
    expect(pcg4d(1, 2, 3, 4)).toEqual([
      908250390, 4044648920, 3775961919, 45698095,
    ]);
    expect(pcg3d(4294967295, 0, 7)).toEqual([
      1019469386, 3322278349, 2765260003,
    ]);
  });

  it('hashes the cells of points, negative ones as their i32 bits', () => {
    const mix = pcg(0);
    expect(hashCell([-1.5, 2.25])).toEqual(
      pcg2d((0xfffffffe ^ mix) >>> 0, (2 ^ mix) >>> 0),
    );
    // Every point of a cell, the same hash; another seed, other values.
    expect(hashCell([3.1, 4.9, -0.2])).toEqual(hashCell([3.9, 4.1, -0.9]));
    expect(hashCell([3, 4, 5], 1)).not.toEqual(hashCell([3, 4, 5]));
    const unit = random([1, 2, 3, 4]);
    expect(unit).toHaveLength(4);
    expect(unit.every((value) => value >= 0 && value < 1)).toBe(true);
  });
});

describe('noises', () => {
  const noises = { valueNoise, perlinNoise, simplexNoise };

  for (const [name, noise] of Object.entries(noises)) {
    for (const dimension of [2, 3, 4]) {
      it(`${name} ${dimension}D stays in [-1, 1], centered, and is smooth`, () => {
        let sum = 0;
        let largest = 0;
        for (const point of points(dimension)) {
          const value = noise(point);
          sum += value;
          largest = Math.max(largest, Math.abs(value));
          // Continuous: a tiny step changes the value a tiny bit.
          const moved = point.map((x) => x + 1e-4);
          expect(Math.abs(noise(moved) - value)).toBeLessThan(0.01);
        }
        expect(largest).toBeLessThanOrEqual(1.05);
        expect(largest).toBeGreaterThan(0.4);
        expect(Math.abs(sum / 2000)).toBeLessThan(0.08);
      });
    }
  }

  it('gives the value of the lattice at its points (value noise)', () => {
    expect(valueNoise([3, -2])).toBeCloseTo(
      toUnit(hashCell([3, -2])[0]) * 2 - 1,
      10,
    );
    // The gradient noise is 0 there.
    expect(perlinNoise([3, -2, 5])).toBeCloseTo(0, 10);
  });

  it('changes with the seed', () => {
    expect(perlinNoise([0.3, 0.6], 1)).not.toBeCloseTo(
      perlinNoise([0.3, 0.6]),
      3,
    );
  });

  for (const dimension of [2, 3, 4]) {
    it(`finds the nearest feature points in ${dimension}D (Worley)`, () => {
      for (const point of points(dimension, 200)) {
        const { f1, f2, id, random: r } = worleyNoise(point);
        expect(f1).toBeGreaterThanOrEqual(0);
        expect(f2).toBeGreaterThanOrEqual(f1);
        expect(Number.isInteger(id) && id >= 0 && id < 2 ** 32).toBe(true);
        expect(r).toBe(toUnit(id));
      }
      // Without jitter, the feature points are the centers of the cells.
      const center = new Array(dimension).fill(0.5);
      expect(worleyNoise(center, 0, 0).f1).toBeCloseTo(0, 10);
      expect(worleyNoise(center, 0, 0).f2).toBeCloseTo(1, 10);
    });
  }

  it('gives the same cell to the points near a feature point', () => {
    const a = worleyNoise([0.5, 0.5], 0, 0);
    const b = worleyNoise([0.52, 0.47], 0, 0);
    expect(b.id).toBe(a.id);
    expect(worleyNoise([1.5, 0.5], 0, 0).id).not.toBe(a.id);
  });
});

describe('fractal sums', () => {
  it('adds the octaves, normalized by their amplitudes', () => {
    const point = [0.37, 1.91, -2.4];
    const options = { octaves: 3, lacunarity: 2, gain: 0.5 };
    const expected =
      (perlinNoise(point) +
        0.5 *
          perlinNoise(
            point.map((x) => x * 2),
            1,
          ) +
        0.25 *
          perlinNoise(
            point.map((x) => x * 4),
            2,
          )) /
      1.75;
    expect(fbm(point, options)).toBeCloseTo(expected, 12);
    const ridge = (n: number) => (1 - Math.abs(n)) ** 2;
    expect(ridged(point, { ...options, octaves: 1 })).toBeCloseTo(
      ridge(perlinNoise(point)),
      12,
    );
    expect(turbulence(point, { ...options, octaves: 1 })).toBeCloseTo(
      Math.abs(perlinNoise(point)),
      12,
    );
  });

  it('fades out the octaves finer than the pixel', () => {
    expect(octaveWeight(0.1, 1)).toBe(1);
    expect(octaveWeight(0.1, 8)).toBe(0);
    // A pixel of 0.1: the octaves of frequency 4 and more are gone.
    const point = [0.37, 1.91];
    const coarse =
      (perlinNoise(point) + 0.5 * perlinNoise([0.74, 3.82], 1)) / 1.96875;
    // The third one (frequency 4) is between the two; the faded part of
    // an octave is its average, 0 for fbm.
    const withThird =
      coarse +
      (0.25 * octaveWeight(0.1, 4) * perlinNoise([1.48, 7.64], 2)) / 1.96875;
    expect(fbm(point, { octaves: 6, footprint: 0.1 })).toBeCloseTo(
      withThird,
      12,
    );
  });

  it('warps the domain by a fbm per coordinate', () => {
    const point = [1.2, 3.4];
    const [x, y] = warp(point, { strength: 2, octaves: 2 });
    expect(x).toBeCloseTo(1.2 + 2 * fbm(point, { octaves: 2, seed: 1013 }), 12);
    expect(y).toBeCloseTo(3.4 + 2 * fbm(point, { octaves: 2, seed: 2026 }), 12);
  });
});
