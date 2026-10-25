import { compile } from '@fdw/engine-shader';
import { describe, expect, it } from 'vitest';
import { bodyContact, bodySpan, FluidBody } from './bodies';
import { ShallowState, stepShallowWater, waterVolume } from './shallow/cpu';
import {
  depthGraph,
  fluxGraph,
  ShallowGrid,
  surfaceGraph,
} from './shallow/graphs';

const parameters = { gravity: 9.81, damping: 0.2, stiffness: 6 };

// A basin of n × n cells of 0.25 m, the water `level` high over a ground.
function basin(
  n: number,
  level: number,
  ground: (i: number, j: number) => number = () => 0,
  open = false,
): ShallowState {
  const grid: ShallowGrid = {
    nx: n,
    nz: n,
    cell: 0.25,
    origin: { x: (-n * 0.25) / 2, z: (-n * 0.25) / 2 },
    open,
  };
  const heights = new Float32Array(n * n);
  const cells = new Float32Array(n * n * 4);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      heights[j * n + i] = ground(i, j);
      cells[(j * n + i) * 4] = Math.max(level - heights[j * n + i], 0);
    }
  }
  return { grid, ground: heights, cells, flux: new Float32Array(n * n * 4) };
}

const sphere = (
  x: number,
  y: number,
  z: number,
  radius: number,
): FluidBody => ({
  shape: { type: 'sphere', radius },
  position: { x, y, z },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  center: { x, y, z },
  velocity: { x: 0, y: 0, z: 0 },
  angularVelocity: { x: 0, y: 0, z: 0 },
});

describe('shallow water', () => {
  it('keeps its water', () => {
    const state = basin(32, 1);
    // A bump of water in the middle.
    for (let j = 12; j < 20; j++) {
      for (let i = 12; i < 20; i++) {
        state.cells[(j * 32 + i) * 4] += 0.3;
      }
    }
    const before = waterVolume(state);
    for (let s = 0; s < 300; s++) {
      stepShallowWater(state, 1 / 60, parameters);
    }
    expect(waterVolume(state)).toBeCloseTo(before, 3);
    // And it spread: the bump is gone.
    let highest = 0;
    for (let k = 0; k < 32 * 32; k++) {
      highest = Math.max(highest, state.cells[k * 4]);
    }
    expect(highest).toBeLessThan(1.1);
  });

  it('stays still on an uneven ground, dry where the ground is above it', () => {
    const state = basin(
      24,
      0.5,
      (i, j) => 0.4 * Math.sin(i / 3) * Math.cos(j / 4) + 0.3,
    );
    for (let s = 0; s < 120; s++) {
      stepShallowWater(state, 1 / 60, parameters);
    }
    for (let k = 0; k < 24 * 24; k++) {
      const surface = state.ground[k] + state.cells[k * 4];
      if (state.cells[k * 4] > 0) {
        expect(surface).toBeCloseTo(0.5, 4);
      } else {
        expect(state.ground[k]).toBeGreaterThanOrEqual(0.5);
      }
      expect(Math.abs(state.cells[k * 4 + 2])).toBeLessThan(1e-4);
    }
  });

  it('spreads a drop the same way in every direction', () => {
    const n = 33;
    const state = basin(n, 1);
    state.cells[(16 * n + 16) * 4] += 0.5;
    for (let s = 0; s < 40; s++) {
      stepShallowWater(state, 1 / 120, parameters);
    }
    const depth = (i: number, j: number) => state.cells[(j * n + i) * 4];
    for (const [di, dj] of [
      [4, 0],
      [7, 3],
      [2, 9],
    ]) {
      const ring = [
        depth(16 + di, 16 + dj),
        depth(16 - di, 16 + dj),
        depth(16 + di, 16 - dj),
        depth(16 - di, 16 - dj),
        depth(16 + dj, 16 + di),
        depth(16 - dj, 16 - di),
      ];
      for (const value of ring) {
        expect(value).toBeCloseTo(ring[0], 5);
      }
    }
    // The drop went out.
    expect(depth(16, 16)).toBeLessThan(1.2);
  });

  it('pours its sources, drains by its open edges', () => {
    const state = basin(16, 0.2);
    const before = waterVolume(state);
    const source = { x: 0, z: 0, radius: 0.5, rate: 0.2 };
    for (let s = 0; s < 60; s++) {
      stepShallowWater(state, 1 / 60, parameters, [], [source]);
    }
    expect(waterVolume(state)).toBeCloseTo(before + 0.2, 3);
    const open = basin(16, 0.2, () => 0, true);
    const full = waterVolume(open);
    for (let s = 0; s < 240; s++) {
      stepShallowWater(open, 1 / 60, parameters);
    }
    expect(waterVolume(open)).toBeLessThan(full * 0.5);
  });

  it('rises around a body sunk into it, by the volume it takes', () => {
    const n = 40;
    const state = basin(n, 1);
    const area = (n * 0.25) ** 2;
    // A ball of 0.5 m, half under the still water.
    const ball = sphere(0, 1, 0, 0.5);
    for (let s = 0; s < 1800; s++) {
      stepShallowWater(state, 1 / 60, parameters, [ball]);
    }
    // The water at the edges: up by 6 / 7 of the half ball over the basin.
    const edge = state.ground[0] + state.cells[0] + state.cells[1];
    const half = ((4 / 3) * Math.PI * 0.5 ** 3) / 2;
    expect(edge - 1).toBeGreaterThan((0.75 * half) / area);
    expect(edge - 1).toBeLessThan((1 * half) / area);
    // Still everywhere: no wave left, nothing growing.
    let fastest = 0;
    for (let k = 0; k < n * n; k++) {
      fastest = Math.max(
        fastest,
        Math.hypot(state.cells[k * 4 + 2], state.cells[k * 4 + 3]),
      );
    }
    expect(fastest).toBeLessThan(0.02);
    expect(waterVolume(state)).toBeCloseTo(area * 1, 2);
  });

  it('compiles its graphs', () => {
    const grid: ShallowGrid = {
      nx: 20,
      nz: 12,
      cell: 0.5,
      origin: { x: -5, z: -3 },
      open: true,
    };
    for (const graph of [
      fluxGraph(grid),
      depthGraph(grid),
      surfaceGraph(grid),
    ]) {
      const program = compile(graph);
      expect(program.module.entryPoints.map((e) => e.stage)).toEqual([
        'compute',
      ]);
    }
  });
});

describe('fluid bodies', () => {
  const box: FluidBody = {
    shape: { type: 'box', halfExtents: { x: 1, y: 0.5, z: 0.25 } },
    position: { x: 1, y: 2, z: 3 },
    // A quarter turn around y: its x along -z of the world.
    rotation: { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 },
    center: { x: 1, y: 2, z: 3 },
    velocity: { x: 1, y: 0, z: 0 },
    angularVelocity: { x: 0, y: 2, z: 0 },
  };

  it('gives the distance to a box, its normal, the velocity of its surface', () => {
    // Along the world z, the box is 1 from its center.
    const front = bodyContact(box, { x: 1, y: 2, z: 4.5 });
    expect(front.distance).toBeCloseTo(0.5);
    expect(front.normal.z).toBeCloseTo(1);
    const inside = bodyContact(box, { x: 1, y: 2.4, z: 3 });
    expect(inside.distance).toBeCloseTo(-0.1);
    expect(inside.normal.y).toBeCloseTo(1);
    // v + ω × r: r = (0, 0, 1.5), ω = (0, 2, 0): ω × r = (3, 0, 0).
    expect(front.velocity.x).toBeCloseTo(4);
    expect(
      bodyContact(sphere(0, 0, 0, 1), { x: 0, y: 3, z: 0 }).distance,
    ).toBeCloseTo(2);
  });

  it('gives the span of a body along a vertical line', () => {
    expect(bodySpan(sphere(0, 1, 0, 0.5), 0, 0)).toEqual({
      low: 0.5,
      high: 1.5,
    });
    expect(bodySpan(sphere(0, 1, 0, 0.5), 0.6, 0)).toBeUndefined();
    const span = bodySpan(box, 1, 3.9);
    expect(span?.low).toBeCloseTo(1.5);
    expect(span?.high).toBeCloseTo(2.5);
    expect(bodySpan(box, 1.3, 3)).toBeUndefined();
    // Tilted by 45° around x: the span grows by √2 at the center.
    const tilted = {
      ...box,
      rotation: {
        x: Math.sin(Math.PI / 8),
        y: 0,
        z: 0,
        w: Math.cos(Math.PI / 8),
      },
    };
    const middle = bodySpan(tilted, 1, 3);
    expect((middle?.high ?? 0) - (middle?.low ?? 0)).toBeCloseTo(
      0.5 * Math.SQRT2 * 2 * 0.5,
      4,
    );
  });
});
