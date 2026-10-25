import { compile } from '@fdw/engine-shader';
import { describe, expect, it } from 'vitest';
import type { FluidBody } from './bodies';
import {
  collide,
  particleBlock,
  particleDensities,
  ParticleState,
  stepParticles,
} from './particles/cpu';
import {
  cellRangesGraph,
  clearCellsGraph,
  columnsGraph,
  deltaGraph,
  keysGraph,
  lambdaGraph,
  predictGraph,
  reorderGraph,
  sortGraph,
  velocityGraph,
  viscosityGraph,
} from './particles/graphs';
import {
  bitonicStages,
  latticeRest,
  particleLayout,
  poly6,
} from './particles/kernels';
import {
  particleDepthGraph,
  smoothDepthGraph,
  liquidShadingGraph,
} from './particles/ParticleFluidRenderer';

const parameters = {
  gravity: 9.81,
  iterations: 4,
  viscosity: 0.02,
  tensile: 0.03,
  maxSpeed: 8,
};

// A state of `count` particles, the first ones at `positions`.
function state(
  layout: ReturnType<typeof particleLayout>,
  positions: Float32Array,
): ParticleState {
  const all = new Float32Array(layout.count * 4);
  all.set(positions);
  return {
    layout,
    positions: all,
    velocities: new Float32Array(layout.count * 4),
    active: positions.length / 4,
  };
}

describe('particles', () => {
  it('has a kernel that sums to 1 over the space', () => {
    const h = 0.2;
    const spacing = h / 20;
    let sum = 0;
    for (let i = -20; i <= 20; i++) {
      for (let j = -20; j <= 20; j++) {
        for (let k = -20; k <= 20; k++) {
          sum +=
            poly6((i * i + j * j + k * k) * spacing * spacing, h) *
            spacing ** 3;
        }
      }
    }
    expect(sum).toBeCloseTo(1, 2);
    // The rest density: a lattice of spacing h / 2, about 1 / spacing³.
    expect(latticeRest(h, h / 2).density * (h / 2) ** 3).toBeCloseTo(1, 0);
  });

  it('sorts by the stages of a bitonic sort', () => {
    const n = 64;
    let entries = Array.from({ length: n }, (_, i) => ({
      key: (i * 37) % 11,
      index: i,
    }));
    // Each stage as a dispatch: every element its own, from the last stage.
    for (const [j, k] of bitonicStages(n)) {
      entries = entries.map((mine, i) => {
        const other = entries[i ^ j];
        const before =
          mine.key < other.key ||
          (mine.key === other.key && mine.index < other.index);
        const smaller = ((i & k) === 0) === ((i & j) === 0);
        return before === smaller ? mine : other;
      });
    }
    const sorted = [...entries].sort(
      (a, b) => a.key - b.key || a.index - b.index,
    );
    expect(entries).toEqual(sorted);
    expect(bitonicStages(16384)).toHaveLength(105);
  });

  it('keeps a block at rest at the density of rest', () => {
    const layout = particleLayout({
      count: 1024,
      radius: 0.05,
      min: [0, 0, 0],
      max: [0.6, 1, 0.6],
    });
    const s = state(layout, particleBlock(layout, [0, 0, 0], [0.6, 0.4, 0.6]));
    for (let i = 0; i < 30; i++) {
      stepParticles(s, 1 / 120, parameters);
    }
    const densities = particleDensities(s);
    expect(Math.max(...densities)).toBeLessThan(1.03);
    let fastest = 0;
    for (let i = 0; i < s.active; i++) {
      fastest = Math.max(
        fastest,
        Math.hypot(
          s.velocities[i * 4],
          s.velocities[i * 4 + 1],
          s.velocities[i * 4 + 2],
        ),
      );
    }
    // Settling under its weight, slowly.
    expect(fastest).toBeLessThan(0.5);
  });

  it('breaks a dam: spreads, settles, stays in its box', () => {
    const layout = particleLayout({
      count: 1024,
      radius: 0.04,
      min: [0, 0, 0],
      max: [1, 0.8, 0.32],
    });
    const s = state(
      layout,
      particleBlock(layout, [0, 0, 0], [0.32, 0.48, 0.32]),
    );
    const front = () => {
      let x = 0;
      for (let i = 0; i < s.active; i++) {
        x = Math.max(x, s.positions[i * 4]);
      }
      return x;
    };
    const start = front();
    for (let i = 0; i < 120; i++) {
      stepParticles(s, 1 / 120, parameters);
    }
    expect(front()).toBeGreaterThan(start + 0.4);
    for (let i = 0; i < s.active; i++) {
      for (let a = 0; a < 3; a++) {
        const v = s.positions[i * 4 + a];
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(layout.min[a] + layout.radius - 1e-5);
        expect(v).toBeLessThanOrEqual(layout.max[a] - layout.radius + 1e-5);
      }
    }
  });

  it('keeps out of the bodies, and the particles not in use stay', () => {
    const layout = particleLayout({
      count: 64,
      radius: 0.05,
      min: [-1, 0, -1],
      max: [1, 2, 1],
    });
    const ball: FluidBody = {
      shape: { type: 'sphere', radius: 0.3 },
      position: { x: 0, y: 1, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      center: { x: 0, y: 1, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      angularVelocity: { x: 0, y: 0, z: 0 },
    };
    const p = [0.1, 1.1, 0];
    collide(layout, [ball], p);
    expect(Math.hypot(p[0], p[1] - 1, p[2])).toBeCloseTo(0.35, 5);
    const s = state(layout, new Float32Array([0, 1.5, 0, 0]));
    s.positions.set([0.5, 0.5, 0.5, 0], 4);
    stepParticles(s, 1 / 60, parameters, [ball]);
    // The inactive one is after the active one, where it was.
    expect([...s.positions.subarray(4, 7)]).toEqual([0.5, 0.5, 0.5]);
    expect(s.positions[1]).toBeLessThan(1.5);
  });

  it('compiles its graphs and its materials', () => {
    const layout = particleLayout({
      count: 256,
      radius: 0.05,
      min: [0, 0, 0],
      max: [1, 1, 1],
    });
    for (const graph of [
      predictGraph(layout),
      keysGraph(layout),
      sortGraph(layout),
      clearCellsGraph(layout),
      cellRangesGraph(layout),
      reorderGraph(layout),
      lambdaGraph(layout),
      deltaGraph(layout),
      velocityGraph(layout),
      viscosityGraph(layout),
      columnsGraph(layout),
    ]) {
      expect(compile(graph).module.entryPoints[0].stage).toBe('compute');
    }
    for (const graph of [
      particleDepthGraph(0.05),
      smoothDepthGraph(),
      liquidShadingGraph(),
    ]) {
      expect(compile(graph).module.entryPoints.map((e) => e.stage)).toContain(
        'fragment',
      );
    }
  });
});
