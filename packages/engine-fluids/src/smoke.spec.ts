import { compile } from '@fdw/engine-shader';
import { describe, expect, it } from 'vitest';
import type { FluidBody } from './bodies';
import {
  createSmokeState,
  shadeSmoke,
  smokeDivergence,
  stepSmoke,
} from './smoke/cpu';
import {
  advectScalarsGraph,
  advectVelocityGraph,
  confineGraph,
  divergenceGraph,
  jacobiGraph,
  projectGraph,
  shadeGraph,
  SmokeLayout,
  solidsGraph,
  vorticityGraph,
} from './smoke/graphs';
import { cellIndex, faceSize, latticeIndex } from './smoke/grid';

const parameters = {
  buoyancy: 1,
  weight: 0.05,
  densityDecay: 0,
  cooling: 0.5,
  vorticity: 2,
  iterations: 40,
};

const layout = (nx: number, ny: number, nz: number): SmokeLayout => ({
  nx,
  ny,
  nz,
  cell: 0.1,
  origin: { x: (-nx * 0.1) / 2, y: 0, z: (-nz * 0.1) / 2 },
  open: ['-x', '+x', '+y', '-z', '+z'],
});

const fire = { x: 0, y: 0.25, z: 0, radius: 0.2, density: 3, temperature: 4 };

// The height of the center of the smoke.
function smokeHeight(state: ReturnType<typeof createSmokeState>): number {
  const { nx, ny, nz } = state.layout;
  let total = 0;
  let weighted = 0;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const density = state.scalars[cellIndex(state.layout, i, j, k) * 4];
        total += density;
        weighted += density * (j + 0.5) * 0.1;
      }
    }
  }
  return weighted / total;
}

describe('smoke', () => {
  it('rises from a fire', () => {
    const state = createSmokeState(layout(8, 16, 8));
    const fire = {
      x: 0,
      y: 0.2,
      z: 0,
      radius: 0.2,
      density: 3,
      temperature: 4,
    };
    stepSmoke(state, 1 / 30, parameters, [], [fire]);
    const start = smokeHeight(state);
    for (let s = 0; s < 40; s++) {
      stepSmoke(state, 1 / 30, parameters, [], [fire]);
    }
    expect(smokeHeight(state)).toBeGreaterThan(start + 0.15);
    // Upward, above the fire.
    const faces = faceSize(state.layout);
    expect(
      state.velocity[latticeIndex(faces, 4, 6, 4) * 4 + 1],
    ).toBeGreaterThan(0.5);
  });

  it('removes the divergence of the velocity', () => {
    const state = createSmokeState({ ...layout(10, 10, 10), open: ['+y'] });
    // A swirl and a source of air, across the inner faces.
    const faces = faceSize(state.layout);
    for (let k = 0; k < 10; k++) {
      for (let j = 0; j < 10; j++) {
        for (let i = 0; i < 10; i++) {
          const n = latticeIndex(faces, i, j, k) * 4;
          state.velocity.set(
            [
              i > 0 ? Math.sin(j * 0.7) + (i - 5) * 0.2 : 0,
              j > 0 ? Math.cos(i * 0.5) + (j - 5) * 0.3 : 0,
              k > 0 ? (k - 5) * 0.1 : 0,
            ],
            n,
          );
        }
      }
    }
    const before = smokeDivergence(state);
    stepSmoke(state, 0, { ...parameters, vorticity: 0, iterations: 600 });
    const after = smokeDivergence(state);
    const rms = (values: Float32Array) =>
      Math.sqrt(values.reduce((sum, v) => sum + v * v, 0) / values.length);
    expect(rms(after)).toBeLessThan(rms(before) * 0.05);
  });

  it('flows around an obstacle, empty of smoke', () => {
    // In a plane: the section of a ball above a fire.
    const state = createSmokeState(layout(24, 32, 1));
    const ball: FluidBody = {
      shape: { type: 'sphere', radius: 0.3 },
      position: { x: 0, y: 1, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      center: { x: 0, y: 1, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      angularVelocity: { x: 0, y: 0, z: 0 },
    };
    for (let s = 0; s < 120; s++) {
      stepSmoke(state, 1 / 30, parameters, [ball], [fire]);
    }
    const inBall = cellIndex(state.layout, 12, 10, 0) * 4;
    expect(state.solids[inBall]).toBe(1);
    expect(state.scalars[inBall]).toBe(0);
    // The smoke went past it, on its sides.
    let above = 0;
    for (let j = 14; j < 32; j++) {
      for (let i = 0; i < 24; i++) {
        above += state.scalars[cellIndex(state.layout, i, j, 0) * 4];
      }
    }
    expect(above).toBeGreaterThan(1);
  });

  it('stays in its plane in 2D', () => {
    const state = createSmokeState(layout(16, 24, 1));
    for (let s = 0; s < 20; s++) {
      stepSmoke(
        state,
        1 / 30,
        parameters,
        [],
        [{ ...fire, velocity: { x: 0.5, y: 0, z: 0.5 } }],
      );
    }
    let rising = 0;
    for (let n = 0; n < 16 * 24; n++) {
      expect(state.velocity[n * 4 + 2]).toBe(0);
      rising = Math.max(rising, state.velocity[n * 4 + 1]);
    }
    expect(rising).toBeGreaterThan(0.2);
  });

  it('lets the light through where there is no smoke', () => {
    const state = createSmokeState(layout(4, 8, 4));
    // Smoke in the top half.
    for (let n = 0; n < 4 * 8 * 4; n++) {
      if (Math.floor(n / 4) % 8 >= 4) {
        state.scalars[n * 4] = 1;
      }
    }
    const shade = shadeSmoke(state, { x: 0, y: 1, z: 0 }, 8, 8);
    const at = (j: number) => shade[cellIndex(state.layout, 1, j, 1) * 4 + 1];
    // From the top cell: half a cell of its own smoke, then the sky.
    expect(at(7)).toBeCloseTo(Math.exp(-0.1 * 8), 4);
    expect(at(5)).toBeLessThan(at(7));
    // From the bottom: the smoke of the top half (4.5 samples of a cell).
    expect(at(1)).toBeCloseTo(Math.exp(-0.45 * 8), 4);
  });

  it('compiles its graphs, in 3D and in a plane', () => {
    for (const grid of [layout(8, 8, 8), layout(16, 16, 1)]) {
      for (const graph of [
        solidsGraph(grid),
        advectVelocityGraph(grid),
        advectScalarsGraph(grid),
        vorticityGraph(grid),
        confineGraph(grid),
        divergenceGraph(grid),
        jacobiGraph(grid),
        projectGraph(grid),
        shadeGraph(grid),
      ]) {
        expect(compile(graph).module.entryPoints[0].stage).toBe('compute');
      }
    }
  });
});
