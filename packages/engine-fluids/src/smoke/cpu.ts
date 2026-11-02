import { simplexNoise } from '@fdw/engine-noise';
import { bodyContact } from '../bodies';
import type { FluidBody } from '../bodies';
import { flickerSpeed } from './graphs';
import type { GridFace, SmokeLayout } from './graphs';
import {
  axes,
  axesOf,
  axisIndex,
  cellIndex,
  cellLattice,
  faceLattice,
  faceSize,
  isFlat,
  latticeIndex,
  sampleLatticeCpu,
} from './grid';

/**
 * The state of a smoke on the CPU: what its buffers hold (vec4 per entry).
 * The velocity is on the faces (see `faceSize`), the rest on the cells.
 */
export interface SmokeState {
  readonly layout: SmokeLayout;
  velocity: Float32Array;
  scalars: Float32Array;
  solids: Float32Array;
  pressure: Float32Array;
  vorticity: Float32Array;
}

/** A sphere that pours smoke and heat into a grid, and blows. */
export interface SmokeEmitter {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radius: number;
  /** The smoke poured, in density per second (1: thick in a second). */
  readonly density: number;
  /** The temperature it heats to (above the air): the fire, the lift. */
  readonly temperature: number;
  /** The velocity it blows, in m/s; without it, the air keeps its own. */
  readonly velocity?: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  };
  /**
   * How much it flickers, from 0 (steady) to 1: a noise rising through it
   * takes up to that share of its smoke and heat (flames).
   */
  readonly turbulence?: number;
}

/** The constants of a step of smoke. */
export interface SmokeParameters {
  /** Upward acceleration per degree of temperature. */
  readonly buoyancy: number;
  /** Downward acceleration per unit of density. */
  readonly weight: number;
  /** How fast the smoke thins, per second. */
  readonly densityDecay: number;
  /** How fast the heat goes, per second. */
  readonly cooling: number;
  /** The strength of the vorticity confinement. */
  readonly vorticity: number;
  /** The steps of the pressure solve. */
  readonly iterations: number;
}

/** The emitters as the graphs read them: three vec4 each. */
export function packEmitters(
  emitters: readonly SmokeEmitter[],
): Float32Array<ArrayBuffer> {
  const data = new Float32Array(Math.max(emitters.length, 1) * 12);
  emitters.forEach((e, n) => {
    // The velocity, and whether it blows.
    const v = e.velocity ?? { x: 0, y: 0, z: 0 };
    data.set(
      [
        e.x,
        e.y,
        e.z,
        e.radius,
        e.density,
        e.temperature,
        e.turbulence ?? 0,
        0,
        v.x,
        v.y,
        v.z,
        e.velocity ? 1 : 0,
      ],
      n * 12,
    );
  });
  return data;
}

/** An empty smoke on the CPU. */
export function createSmokeState(layout: SmokeLayout): SmokeState {
  const cells = layout.nx * layout.ny * layout.nz * 4;
  const [fx, fy, fz] = faceSize(layout);
  return {
    layout,
    velocity: new Float32Array(fx * fy * fz * 4),
    scalars: new Float32Array(cells),
    solids: new Float32Array(cells),
    pressure: new Float32Array(cells),
    vorticity: new Float32Array(cells),
  };
}

const smoothstep = (low: number, high: number, x: number) => {
  const t = Math.min(Math.max((x - low) / (high - low), 0), 1);
  return t * t * (3 - 2 * t);
};

/**
 * A frame of smoke on the CPU: the same passes as the compute graphs
 * (obstacles, advection, vorticity, confinement, divergence, pressure,
 * projection), for the tests.
 *
 * The loops go over integer indices, with their scratch made once per
 * step: nothing is allocated per cell or per face.
 */
export function stepSmoke(
  state: SmokeState,
  dt: number,
  parameters: SmokeParameters,
  bodies: readonly FluidBody[] = [],
  emitters: readonly SmokeEmitter[] = [],
  time = 0,
): void {
  const grid = state.layout;
  const { nx, ny, nz, cell, origin } = grid;
  const flat = isFlat(grid);
  const cellCount = [nx, ny, nz] as const;
  const cells = nx * ny * nz;
  const faces = faceSize(grid);
  const [fx, fy, fz] = faces;
  // The axes of the grid, by index: two in a plane.
  const axisCount = axesOf(grid).length;
  // Whether each side of the grid is open, per axis.
  const openLow = axes.map((axis) =>
    grid.open.includes(`-${axis}` as GridFace),
  );
  const openHigh = axes.map((axis) =>
    grid.open.includes(`+${axis}` as GridFace),
  );
  // The lattices, once per step.
  const cellValues = cellLattice(grid);
  const faceValues = axes.map((axis) => faceLattice(grid, axis));
  // The steps between neighbors along each axis, in cells and in faces.
  const cellStride = [1, nx, nx * ny] as const;
  const faceStride = [1, fx, fx * fy] as const;

  const sample = new Float32Array(4);
  // The velocity at a point, into (vx, vy, vz).
  let vx = 0;
  let vy = 0;
  let vz = 0;
  const velocityAt = (field: Float32Array, x: number, y: number, z: number) => {
    vx = sampleLatticeCpu(grid, faceValues[0], field, x, y, z, sample)[0];
    vy = sampleLatticeCpu(grid, faceValues[1], field, x, y, z, sample)[1];
    vz = flat
      ? 0
      : sampleLatticeCpu(grid, faceValues[2], field, x, y, z, sample)[2];
  };
  // Where the air at a point comes from (a midpoint step), into (bx, by, bz).
  let bx = 0;
  let by = 0;
  let bz = 0;
  const backtrace = (field: Float32Array, x: number, y: number, z: number) => {
    velocityAt(field, x, y, z);
    velocityAt(field, x - vx * dt * 0.5, y - vy * dt * 0.5, z - vz * dt * 0.5);
    bx = x - vx * dt;
    by = y - vy * dt;
    bz = z - vz * dt;
  };

  // 1. The obstacles.
  const solids = state.solids;
  const solid = new Uint8Array(cells);
  const point = { x: 0, y: 0, z: 0 };
  for (let k = 0, n = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++, n++) {
        point.x = origin.x + (i + 0.5) * cell;
        point.y = origin.y + (j + 0.5) * cell;
        point.z = origin.z + (k + 0.5) * cell;
        solids.fill(0, n * 4, n * 4 + 4);
        for (const body of bodies) {
          const contact = bodyContact(body, point);
          if (contact.distance < 0) {
            solids[n * 4] = 1;
            solids[n * 4 + 1] = contact.velocity.x;
            solids[n * 4 + 2] = contact.velocity.y;
            solids[n * 4 + 3] = contact.velocity.z;
          }
        }
        solid[n] = solids[n * 4] > 0.5 ? 1 : 0;
      }
    }
  }

  // The face across axis `a` at entry (i, j, k) of the faces: whether it
  // is one, and its cells and its position into the variables below.
  let hasBefore = false;
  let hasAfter = false;
  let before = 0;
  let after = 0;
  let px = 0;
  let py = 0;
  let pz = 0;
  const faceAt = (i: number, j: number, k: number, a: number): boolean => {
    const c = a === 0 ? i : a === 1 ? j : k;
    if (
      c > cellCount[a] ||
      (a !== 0 && i >= nx) ||
      (a !== 1 && j >= ny) ||
      (a !== 2 && !flat && k >= nz)
    ) {
      return false;
    }
    hasBefore = c > 0;
    hasAfter = c < cellCount[a];
    after = cellIndex(
      grid,
      Math.min(i, nx - 1),
      Math.min(j, ny - 1),
      Math.min(k, nz - 1),
    );
    before = hasBefore ? cellIndex(grid, i, j, k) - cellStride[a] : after;
    px = origin.x + (i + (a === 0 ? 0 : 0.5)) * cell;
    py = origin.y + (j + (a === 1 ? 0 : 0.5)) * cell;
    pz = origin.z + (k + (a === 2 ? 0 : 0.5)) * cell;
    return true;
  };
  // A value on the face last found by `faceAt`, held by the walls and the
  // obstacles.
  const constrain = (a: number, value: number) => {
    if (!hasBefore) {
      return openLow[a] ? value : 0;
    }
    if (!hasAfter) {
      return openHigh[a] ? value : 0;
    }
    if (solid[after]) {
      return solids[after * 4 + 1 + a];
    }
    if (solid[before]) {
      return solids[before * 4 + 1 + a];
    }
    return value;
  };

  // 2. The advection of the velocity, the forces, the emitters.
  const advected = new Float32Array(state.velocity.length);
  for (let k = 0, n = 0; k < fz; k++) {
    for (let j = 0; j < fy; j++) {
      for (let i = 0; i < fx; i++, n++) {
        for (let a = 0; a < axisCount; a++) {
          if (!faceAt(i, j, k, a)) {
            continue;
          }
          const x = px;
          const y = py;
          const z = pz;
          backtrace(state.velocity, x, y, z);
          let value = sampleLatticeCpu(
            grid,
            faceValues[a],
            state.velocity,
            bx,
            by,
            bz,
            sample,
          )[a];
          if (a === 1) {
            const here = sampleLatticeCpu(
              grid,
              cellValues,
              state.scalars,
              x,
              y,
              z,
              sample,
            );
            value +=
              (parameters.buoyancy * here[1] - parameters.weight * here[0]) *
              dt;
          }
          let blown = 0;
          let weight = 0;
          for (const e of emitters) {
            if (!e.velocity) {
              continue;
            }
            const s =
              1 -
              smoothstep(
                e.radius * 0.5,
                e.radius,
                Math.hypot(x - e.x, y - e.y, z - e.z),
              );
            const v = e.velocity;
            blown += (a === 0 ? v.x : a === 1 ? v.y : v.z) * s;
            weight += s;
          }
          const blowing = Math.min(weight, 1);
          value += (blown / Math.max(weight, 1e-6) - value) * blowing;
          advected[n * 4 + a] = constrain(a, value);
        }
      }
    }
  }

  // 3. The advection of the scalars, the emitters.
  const scalars = new Float32Array(state.scalars.length);
  const noisePoint = [0, 0, 0];
  for (let k = 0, n = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++, n++) {
        if (solid[n]) {
          continue;
        }
        const x = origin.x + (i + 0.5) * cell;
        const y = origin.y + (j + 0.5) * cell;
        const z = origin.z + (k + 0.5) * cell;
        backtrace(state.velocity, x, y, z);
        const carried = sampleLatticeCpu(
          grid,
          cellValues,
          state.scalars,
          bx,
          by,
          bz,
          sample,
        );
        let poured = 0;
        let heat = 0;
        for (const e of emitters) {
          noisePoint[0] = (x * 2) / e.radius;
          noisePoint[1] = (y * 2) / e.radius - time * flickerSpeed;
          noisePoint[2] = (z * 2) / e.radius;
          const noise = simplexNoise(noisePoint);
          const flicker = 1 - (e.turbulence ?? 0) * (noise * 0.5 + 0.5);
          const s =
            (1 -
              smoothstep(
                e.radius * 0.5,
                e.radius,
                Math.hypot(x - e.x, y - e.y, z - e.z),
              )) *
            flicker;
          poured += e.density * s * dt;
          heat = Math.max(heat, e.temperature * s);
        }
        scalars[n * 4] =
          (carried[0] + poured) / (1 + dt * parameters.densityDecay);
        scalars[n * 4 + 1] =
          Math.max(carried[1], heat) / (1 + dt * parameters.cooling);
      }
    }
  }
  state.scalars = scalars;

  // The neighbor of cell n (at c along axis a), itself past an edge.
  const neighbor = (n: number, c: number, a: number, side: -1 | 1) => {
    const at = c + side;
    return at >= 0 && at < cellCount[a] ? n + side * cellStride[a] : n;
  };

  // The velocity at the center of each cell (vec3; 0 along z in a plane).
  const centered = new Float64Array(cells * 3);
  for (let k = 0, n = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++, n++) {
        const f = latticeIndex(faces, i, j, k);
        for (let a = 0; a < axisCount; a++) {
          centered[n * 3 + a] =
            (advected[f * 4 + a] + advected[(f + faceStride[a]) * 4 + a]) / 2;
        }
      }
    }
  }

  // 4. The vorticity.
  const vorticity = state.vorticity;
  // The derivative along axis a (the cell at c along it) of component b.
  const derivative = (n: number, c: number, a: number, b: number) =>
    (centered[neighbor(n, c, a, 1) * 3 + b] -
      centered[neighbor(n, c, a, -1) * 3 + b]) /
    (2 * cell);
  for (let k = 0, n = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++, n++) {
        const wx = flat ? 0 : derivative(n, j, 1, 2) - derivative(n, k, 2, 1);
        const wy = flat ? 0 : derivative(n, k, 2, 0) - derivative(n, i, 0, 2);
        const wz = derivative(n, i, 0, 1) - derivative(n, j, 1, 0);
        vorticity[n * 4] = wx;
        vorticity[n * 4 + 1] = wy;
        vorticity[n * 4 + 2] = wz;
        vorticity[n * 4 + 3] = Math.hypot(wx, wy, wz);
      }
    }
  }

  // 5. The confinement: its force at the center of each cell first.
  const forces = new Float64Array(cells * 3);
  const strength = parameters.vorticity * cell;
  for (let k = 0, n = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++, n++) {
        const norm = (c: number, a: number, side: -1 | 1) =>
          vorticity[neighbor(n, c, a, side) * 4 + 3];
        const g0 = norm(i, 0, 1) - norm(i, 0, -1);
        const g1 = norm(j, 1, 1) - norm(j, 1, -1);
        const g2 = flat ? 0 : norm(k, 2, 1) - norm(k, 2, -1);
        const length = Math.max(Math.hypot(g0, g1, g2), 1e-6);
        const x = g0 / length;
        const y = g1 / length;
        const z = g2 / length;
        const w0 = vorticity[n * 4];
        const w1 = vorticity[n * 4 + 1];
        const w2 = vorticity[n * 4 + 2];
        forces[n * 3] = (y * w2 - z * w1) * strength;
        forces[n * 3 + 1] = (z * w0 - x * w2) * strength;
        forces[n * 3 + 2] = (x * w1 - y * w0) * strength;
      }
    }
  }
  const confined = new Float32Array(advected.length);
  for (let k = 0, n = 0; k < fz; k++) {
    for (let j = 0; j < fy; j++) {
      for (let i = 0; i < fx; i++, n++) {
        // The cell after the face, clamped to the grid.
        const ci = Math.min(i, nx - 1);
        const cj = Math.min(j, ny - 1);
        const ck = Math.min(k, nz - 1);
        const m = cellIndex(grid, ci, cj, ck);
        for (let a = 0; a < axisCount; a++) {
          if (!faceAt(i, j, k, a)) {
            continue;
          }
          const low = neighbor(m, a === 0 ? ci : a === 1 ? cj : ck, a, -1);
          const value =
            advected[n * 4 + a] +
            ((forces[m * 3 + a] + forces[low * 3 + a]) / 2) * dt;
          confined[n * 4 + a] = constrain(a, value);
        }
      }
    }
  }

  // 6. The divergence, the pressure from the last frame.
  const pressure = new Float32Array(state.pressure.length);
  for (let k = 0, n = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++, n++) {
        const f = latticeIndex(faces, i, j, k);
        let divergence = 0;
        for (let a = 0; a < axisCount; a++) {
          divergence +=
            confined[(f + faceStride[a]) * 4 + a] - confined[f * 4 + a];
        }
        pressure[n * 4] = state.pressure[n * 4];
        pressure[n * 4 + 1] = divergence / cell;
      }
    }
  }

  // 7. The pressure, between two buffers in turn.
  let current = pressure;
  let next = new Float32Array(pressure.length);
  for (let iteration = 0; iteration < parameters.iterations; iteration++) {
    for (let k = 0, n = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++, n++) {
          let sum = 0;
          let count = 0;
          for (let a = 0; a < axisCount; a++) {
            const c = a === 0 ? i : a === 1 ? j : k;
            for (let side = -1; side <= 1; side += 2) {
              const at = c + side;
              if (at < 0 || at >= cellCount[a]) {
                count += (side < 0 ? openLow[a] : openHigh[a]) ? 1 : 0;
                continue;
              }
              const m = n + side * cellStride[a];
              if (!solid[m]) {
                sum += current[m * 4];
                count++;
              }
            }
          }
          next[n * 4] =
            count > 0 ? (sum - current[n * 4 + 1] * cell * cell) / count : 0;
          next[n * 4 + 1] = current[n * 4 + 1];
        }
      }
    }
    const done = next;
    next = current;
    current = done;
  }
  state.pressure = current;

  // 8. The projection.
  const projected = new Float32Array(confined.length);
  for (let k = 0, n = 0; k < fz; k++) {
    for (let j = 0; j < fy; j++) {
      for (let i = 0; i < fx; i++, n++) {
        for (let a = 0; a < axisCount; a++) {
          if (!faceAt(i, j, k, a)) {
            continue;
          }
          const high = hasAfter ? current[after * 4] : 0;
          const low = hasBefore ? current[before * 4] : 0;
          projected[n * 4 + a] = constrain(
            a,
            confined[n * 4 + a] - (high - low) / cell,
          );
        }
      }
    }
  }
  state.velocity = projected;
}

/**
 * The shade of a smoke on the CPU (see `shadeGraph`): density, light from
 * the sun, temperature.
 */
export function shadeSmoke(
  state: SmokeState,
  sun: { readonly x: number; readonly y: number; readonly z: number },
  extinction: number,
  steps: number,
): Float32Array {
  const grid = state.layout;
  const { nx, ny, nz, cell, origin } = grid;
  const length = Math.hypot(sun.x, sun.y, sun.z) || 1;
  const dx = sun.x / length;
  const dy = sun.y / length;
  const dz = sun.z / length;
  const lattice = cellLattice(grid);
  const shade = new Float32Array(nx * ny * nz * 4);
  const sample = new Float32Array(4);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const n = cellIndex(grid, i, j, k);
        const x = origin.x + (i + 0.5) * cell;
        const y = origin.y + (j + 0.5) * cell;
        const z = origin.z + (k + 0.5) * cell;
        let total = 0;
        for (let s = 0; s < steps; s++) {
          const t = (s + 0.5) * cell;
          total += sampleLatticeCpu(
            grid,
            lattice,
            state.scalars,
            x + dx * t,
            y + dy * t,
            z + dz * t,
            sample,
            'zero',
          )[0];
        }
        shade[n * 4] = state.scalars[n * 4];
        shade[n * 4 + 1] = Math.exp(-total * cell * extinction);
        shade[n * 4 + 2] = state.scalars[n * 4 + 1];
      }
    }
  }
  return shade;
}

/** The divergence of the velocity of a state across the faces of each cell (for the tests). */
export function smokeDivergence(state: SmokeState): Float32Array {
  const grid = state.layout;
  const faces = faceSize(grid);
  const result = new Float32Array(grid.nx * grid.ny * grid.nz);
  for (let k = 0; k < grid.nz; k++) {
    for (let j = 0; j < grid.ny; j++) {
      for (let i = 0; i < grid.nx; i++) {
        let divergence = 0;
        for (const axis of axesOf(grid)) {
          const a = axisIndex[axis];
          const high = [i, j, k];
          high[a]++;
          divergence +=
            state.velocity[
              latticeIndex(faces, high[0], high[1], high[2]) * 4 + a
            ] - state.velocity[latticeIndex(faces, i, j, k) * 4 + a];
        }
        result[cellIndex(grid, i, j, k)] = divergence / grid.cell;
      }
    }
  }
  return result;
}
