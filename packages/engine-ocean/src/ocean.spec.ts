import { Camera, Renderer } from '@fdw/engine-core';
import { fakeBackend, surface } from '@fdw/engine-core/testing';
import type { PhysicsBody } from '@fdw/engine-physics';
import { compile } from '@fdw/engine-shader';
import { describe, expect, it } from 'vitest';
import { boxPoints, Buoyancy } from './Buoyancy';
import { clipmapGrid } from './clipmap';
import { butterflyTables, inverseFft2d, reverseBits } from './fft';
import { evaluateSpectrum, sampleFields } from './fields';
import { GerstnerWaves } from './gerstner';
import { butterflyGraph, resolveGraph, spectrumGraph } from './graphs';
import { oceanGraph } from './material';
import { Ocean } from './Ocean';
import { OceanSpectrum } from './OceanSpectrum';
import {
  heightAbove,
  sampleJacobian,
  sampleNormal,
  waveSample,
} from './sample';
import { gerstnerShader } from './shader';
import { createSpectrum, spectrumDensity } from './spectrum';

// A generator of floats in [0, 1), for the inputs of the tests.
const random = (seed: number) => () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
};

describe('FFT', () => {
  it('reverses the bits', () => {
    expect(reverseBits(1, 3)).toBe(4);
    expect(reverseBits(6, 3)).toBe(3);
    expect(reverseBits(5, 4)).toBe(10);
  });

  it('computes the inverse DFT of the rows and columns', () => {
    const n = 16;
    const next = random(7);
    const data = Float64Array.from(
      { length: 2 * n * n * 2 },
      () => next() - 0.5,
    );
    const expected = new Float64Array(data.length);
    for (let grid = 0; grid < 2; grid++) {
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          let re = 0;
          let im = 0;
          for (let v = 0; v < n; v++) {
            for (let u = 0; u < n; u++) {
              const i = 2 * (grid * n * n + v * n + u);
              const angle = (2 * Math.PI * (u * x + v * y)) / n;
              re += data[i] * Math.cos(angle) - data[i + 1] * Math.sin(angle);
              im += data[i] * Math.sin(angle) + data[i + 1] * Math.cos(angle);
            }
          }
          const o = 2 * (grid * n * n + y * n + x);
          expected[o] = re;
          expected[o + 1] = im;
        }
      }
    }
    inverseFft2d(data, n);
    // The twiddles are floats, as on the GPU.
    data.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 5));
  });

  it('refuses a size that is not a power of 2', () => {
    expect(() => butterflyTables(12)).toThrow(/power of 2/);
  });
});

describe('spectrum', () => {
  it('has the variance of its spectrum, and no waves against the wind', () => {
    const data = createSpectrum({ seed: 3 });
    const fields = evaluateSpectrum(data, 0);
    // The heights of the grids of the cascades are independent: their
    // variances add up.
    const { resolution: n } = data;
    let sum = 0;
    for (let i = 0; i < fields.displacement.length; i += 4) {
      sum += fields.displacement[i + 1] ** 2;
    }
    const deviation = Math.sqrt(sum / (n * n));
    expect(deviation).toBeGreaterThan(data.heightDeviation * 0.8);
    expect(deviation).toBeLessThan(data.heightDeviation * 1.2);
    // A sea of 8 m/s: some tens of centimeters.
    expect(data.heightDeviation).toBeGreaterThan(0.15);
    expect(data.heightDeviation).toBeLessThan(0.6);
    expect(spectrumDensity(-0.3, 0, { model: 'phillips' })).toBe(0);
    expect(spectrumDensity(0.3, 0, { model: 'phillips' })).toBeGreaterThan(0);
  });

  it('gives the sum of its waves at every point, fields packed by two', () => {
    const n = 16;
    const data = createSpectrum({ resolution: n, cascades: [40], seed: 5 });
    const time = 3.7;
    const fields = evaluateSpectrum(data, time, 0.8);
    // The direct sum of the waves at a few points of the grid.
    for (const [column, row] of [
      [0, 0],
      [3, 11],
      [15, 7],
    ]) {
      const x = (column * 40) / n;
      const z = (row * 40) / n;
      const sum = waveSample();
      for (let i = 0; i < n * n; i++) {
        const [ar, ai, br, bi] = data.amplitudes.subarray(i * 4, i * 4 + 4);
        const [kx, kz, omega, inverse] = data.waves.subarray(i * 4, i * 4 + 4);
        const c = Math.cos(omega * time);
        const s = Math.sin(omega * time);
        const hr = ar * c - ai * s + br * c + bi * s;
        const hi = ar * s + ai * c + bi * c - br * s;
        // The real part of h e^(ik·x), of its derivatives.
        const e = kx * x + kz * z;
        const re = (fr: number, fi: number) =>
          fr * Math.cos(e) - fi * Math.sin(e);
        sum.h += re(hr, hi);
        sum.dx += 0.8 * re(hi * kx * inverse, -hr * kx * inverse);
        sum.dz += 0.8 * re(hi * kz * inverse, -hr * kz * inverse);
        sum.dhdx += re(-hi * kx, hr * kx);
        sum.dhdz += re(-hi * kz, hr * kz);
        sum.dxdx += 0.8 * re(hr * kx * kx * inverse, hi * kx * kx * inverse);
        sum.dzdz += 0.8 * re(hr * kz * kz * inverse, hi * kz * kz * inverse);
        sum.dxdz += 0.8 * re(hr * kx * kz * inverse, hi * kx * kz * inverse);
      }
      const p = (row * n + column) * 4;
      const d = fields.displacement;
      const g = fields.derivatives;
      const actual = [
        d[p],
        d[p + 1],
        d[p + 2],
        d[p + 3],
        g[p],
        g[p + 1],
        g[p + 2],
        g[p + 3],
      ];
      const expected = [
        sum.dx,
        sum.h,
        sum.dz,
        sum.dxdz,
        sum.dhdx,
        sum.dhdz,
        sum.dxdx,
        sum.dzdz,
      ];
      actual.forEach((value, k) => expect(value).toBeCloseTo(expected[k], 4));
    }
  });

  it('loops over its period', () => {
    const data = createSpectrum({ resolution: 16, cascades: [30], period: 20 });
    const a = evaluateSpectrum(data, 1.5).displacement;
    const b = evaluateSpectrum(data, 21.5).displacement;
    a.forEach((value, i) => expect(b[i]).toBeCloseTo(value, 3));
  });

  it('samples the cascades between their points, the tiles repeating', () => {
    const data = createSpectrum({ resolution: 16, cascades: [30, 16] });
    const fields = evaluateSpectrum(data, 1);
    const a = sampleFields(fields, 2.2, -3.1, waveSample());
    const b = sampleFields(fields, 2.2 + 240, -3.1 - 240, waveSample());
    expect(b.h).toBeCloseTo(a.h, 4);
    expect(() => createSpectrum({ cascades: [100, 1] })).toThrow(/too small/);
  });
});

describe('Gerstner waves', () => {
  const waves = new GerstnerWaves([
    { direction: 0.3, wavelength: 20, amplitude: 0.5, steepness: 0.8 },
    { direction: 1.9, wavelength: 7, amplitude: 0.15, phase: 1 },
  ]);
  waves.update(2.5);

  it('gives the derivatives of its motion', () => {
    const e = 1e-4;
    const at = (x: number, z: number) => waves.sample(x, z);
    const s = at(3, -4);
    const sx = at(3 + e, -4);
    const sz = at(3, -4 + e);
    expect(s.dhdx).toBeCloseTo((sx.h - s.h) / e, 3);
    expect(s.dhdz).toBeCloseTo((sz.h - s.h) / e, 3);
    expect(s.dxdx).toBeCloseTo((sx.dx - s.dx) / e, 3);
    expect(s.dzdz).toBeCloseTo((sz.dz - s.dz) / e, 3);
    expect(s.dxdz).toBeCloseTo((sz.dx - s.dx) / e, 3);
    expect(s.dxdz).toBeCloseTo((sx.dz - s.dz) / e, 3);
    const normal = sampleNormal(s);
    expect(Math.hypot(normal.x, normal.y, normal.z)).toBeCloseTo(1, 6);
    expect(sampleJacobian(waveSample())).toBe(1);
  });

  it('finds the height of the water above a point of the world', () => {
    const s = waves.sample(5, 1);
    const height = waves.heightAt(5 + s.dx, 1 + s.dz);
    expect(height).toBeCloseTo(s.h, 4);
    expect(
      heightAbove((x, z, out) => waves.sample(x, z, out), 5 + s.dx, 1 + s.dz),
    ).toBeCloseTo(s.h, 4);
  });

  it('wraps the phases: exact at any time', () => {
    const late = new GerstnerWaves(waves.waves);
    late.update(1e6);
    for (const phase of late.phases()) {
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(2 * Math.PI);
    }
  });
});

describe('clipmap grid', () => {
  const grid = clipmapGrid({ cell: 1, levels: 3, size: 8, horizon: 400 });
  const positions = grid.mesh.vertices[0] as Float32Array;
  const indices = grid.mesh.indices as Uint16Array;

  it('faces up, without folded triangles', () => {
    for (let t = 0; t < indices.length; t += 3) {
      const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]].map(
        (i) => [positions[i * 3], positions[i * 3 + 2]],
      );
      // y of (b - a) × (c - a), with (x, z).
      const up = (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]);
      expect(up).toBeGreaterThan(0);
    }
  });

  it('shares the edges of the rings: no crack where they meet', () => {
    const edges = new Map<string, number>();
    for (let t = 0; t < indices.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const a = indices[t + k];
        const b = indices[t + ((k + 1) % 3)];
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    }
    for (const [key, count] of edges) {
      if (count === 2) continue;
      // Used once: where the squares of the skirt (flat, the waves faded
      // out) meet the rings and each other, and the horizon.
      const [a, b] = key.split(',').map(Number);
      const radius = (i: number) =>
        Math.max(Math.abs(positions[i * 3]), Math.abs(positions[i * 3 + 2]));
      const onSquare = (r: number) =>
        r >= grid.extent && Number.isInteger(Math.log2(r / grid.extent));
      expect(
        radius(a) === radius(b) && onSquare(radius(a)),
        `edge ${key}: ${[a, b].map((i) => `${positions[i * 3]},${positions[i * 3 + 2]}`)}`,
      ).toBe(true);
    }
    expect(grid.extent).toBe(32);
    expect(grid.step).toBe(4);
    expect(grid.horizon).toBeGreaterThanOrEqual(400);
  });
});

describe('buoyancy', () => {
  // A body of the physics, without an engine: the forces applied.
  const body = (y: number) => {
    const forces: { y: number; point: { y: number } }[] = [];
    const world = { bodies: [] as PhysicsBody[] };
    const fake = {
      world,
      position: { x: 0, y, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      linearVelocity: { x: 0, y: 0, z: 0 },
      angularVelocity: { x: 0, y: 0, z: 0 },
      mass: 500,
      sleeping: false,
      wakeUp: () => undefined,
      applyForce: (force: { y: number }, point: { y: number }) =>
        forces.push({ y: force.y, point: { y: point.y } }),
    } as unknown as PhysicsBody;
    world.bodies.push(fake);
    return { fake, forces, world };
  };

  it('pushes up by the weight of the water pushed away', () => {
    const buoyancy = new Buoyancy(
      { heightAt: () => 0 },
      { density: 1000, gravity: 10 },
    );
    const points = boxPoints({ x: 0.5, y: 0.5, z: 0.5 });
    expect(points).toHaveLength(8);
    // Half under water: the bottom points wet, the top ones dry.
    const half = body(0);
    buoyancy.add(half.fake, { points, volume: 1, depth: 0.5 });
    buoyancy.step();
    const lift = half.forces.reduce((sum, force) => sum + force.y, 0);
    expect(lift).toBeCloseTo(5000, 6);
    expect(buoyancy.floaterOf(half.fake)?.submerged).toBeCloseTo(0.5, 6);
    // In the air: nothing.
    const dry = body(3);
    buoyancy.add(dry.fake, { points, volume: 1 });
    buoyancy.step();
    expect(dry.forces).toHaveLength(0);
    // Removed from its world: forgotten.
    dry.world.bodies.length = 0;
    buoyancy.step();
    expect(buoyancy.floaterOf(dry.fake)).toBeUndefined();
  });
});

describe('ocean', () => {
  it('compiles the compute graphs of the spectrum', () => {
    for (const graph of [
      spectrumGraph(16),
      butterflyGraph(16, 'rows'),
      butterflyGraph(16, 'columns'),
      resolveGraph(16),
    ]) {
      const stages = compile(graph).module.entryPoints.map(
        (entry) => entry.stage,
      );
      expect(stages).toEqual(['compute']);
    }
  });

  it('compiles its material, with or without what is behind the water', () => {
    const waves = new GerstnerWaves([
      { direction: 0, wavelength: 10, amplitude: 0.3 },
    ]);
    for (const refraction of [false, true]) {
      const program = compile(
        oceanGraph(gerstnerShader(waves), {
          refraction,
          fade: { scale: 2, limit: 500 },
        }),
      );
      const names = program.layout.groups.flatMap((group) =>
        group.bindings.map((binding) => binding.name),
      );
      expect(names).toContain('environment');
      expect(names.includes('sceneColor')).toBe(refraction);
    }
  });

  it('follows the camera by steps of its coarsest cell, and draws', () => {
    const { backend } = fakeBackend({
      objectTable: true,
      compute: true,
      storageBuffers: true,
    });
    const spectrum = new OceanSpectrum(backend, {
      resolution: 16,
      cascades: [50, 26],
      readback: false,
    });
    const sky = {
      texture: backend.textures.createTexture({
        type: 'cube',
        format: 'rgba8unorm',
        dimensions: { width: 4, height: 4, layers: 6 },
      }),
      sampler: backend.textures.createSampler(),
      levels: 3,
    };
    const ocean = new Ocean({
      waves: spectrum,
      environment: sky,
      level: 2,
      refraction: false,
    });
    ocean.update({ x: 50, y: 10, z: -50 }, 1);
    const step = ocean.grid.step;
    expect(ocean.world.matrix[12]).toBe(Math.round(50 / step) * step);
    expect(ocean.world.matrix[13]).toBe(2);
    expect(ocean.bounds.max[1]).toBeGreaterThan(2);
    // The heights of the CPU: computed until the GPU is read back.
    const s = spectrum.sample(3, 4);
    expect(ocean.heightAt(3 + s.dx, 4 + s.dz)).toBeCloseTo(2 + s.h, 4);
    const camera = new Camera({
      position: { x: 50, y: 10, z: -50 },
      projection: {
        type: 'perspective',
        fov: 60,
        aspect: 1,
        near: 0.1,
        far: 1000,
      },
    });
    const renderer = new Renderer(backend);
    expect(() =>
      renderer.render({ items: [ocean], camera, surface }),
    ).not.toThrow();
    expect(renderer.stats.get('scene')?.drawn).toBe(1);
  });
});
