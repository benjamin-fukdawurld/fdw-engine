import { bodySpan } from '../bodies';
import type { FluidBody } from '../bodies';
import type { ShallowGrid } from './graphs';

/** The state of a shallow water on the CPU: what its buffers hold. */
export interface ShallowState {
  readonly grid: ShallowGrid;
  /** The height of the ground of each cell, row after row (j along z). */
  readonly ground: Float32Array;
  /** Depth, occupancy, velocity x, velocity z, of each cell. */
  cells: Float32Array;
  /** The water leaving toward -x, +x, -z, +z, of each cell (m³/s). */
  flux: Float32Array;
}

/** A source of water: a rate (m³/s, negative to drain) over a disc. */
export interface WaterSource {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly rate: number;
}

/** The constants of a step. */
export interface ShallowParameters {
  readonly gravity: number;
  /** How fast the fluxes fade, per second. */
  readonly damping: number;
  /**
   * How much of a body sunk into the water raises it: the occupancy of a
   * column is `stiffness` times the part of the body under the water
   * alone, up to the whole body (see `depthGraph`).
   */
  readonly stiffness: number;
}

/**
 * A step of the shallow water on the CPU: the same as the compute graphs
 * (see `fluxGraph` and `depthGraph`), for the tests and the CPU before the
 * first read back.
 */
export function stepShallowWater(
  state: ShallowState,
  dt: number,
  parameters: ShallowParameters,
  bodies: readonly FluidBody[] = [],
  sources: readonly WaterSource[] = [],
): void {
  const { nx, nz, cell, origin, open } = state.grid;
  const { ground, cells, flux } = state;
  const nextFlux = new Float32Array(flux.length);
  const height = (k: number) => ground[k] + cells[k * 4] + cells[k * 4 + 1];
  const keep = Math.max(1 - parameters.damping * dt, 0);
  const gain = dt * parameters.gravity * cell;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const h = height(k);
      const beyond = open ? ground[k] : h;
      const neighbors = [
        i > 0 ? height(k - 1) : beyond,
        i < nx - 1 ? height(k + 1) : beyond,
        j > 0 ? height(k - nx) : beyond,
        j < nz - 1 ? height(k + nx) : beyond,
      ];
      let total = 0;
      for (let side = 0; side < 4; side++) {
        const f = Math.max(
          flux[k * 4 + side] * keep + gain * (h - neighbors[side]),
          0,
        );
        nextFlux[k * 4 + side] = f;
        total += f;
      }
      const water = cells[k * 4] * cell * cell;
      const scale = Math.min(water / Math.max(total * dt, 1e-12), 1);
      for (let side = 0; side < 4; side++) {
        nextFlux[k * 4 + side] *= scale;
      }
    }
  }
  const next = new Float32Array(cells.length);
  const area = cell * cell;
  const rates = sourceRates(state.grid, sources);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const inLeft = i > 0 ? nextFlux[(k - 1) * 4 + 1] : 0;
      const inRight = i < nx - 1 ? nextFlux[(k + 1) * 4] : 0;
      const inBack = j > 0 ? nextFlux[(k - nx) * 4 + 3] : 0;
      const inFront = j < nz - 1 ? nextFlux[(k + nx) * 4 + 2] : 0;
      const out = nextFlux.subarray(k * 4, k * 4 + 4);
      const x = origin.x + cell / 2 + i * cell;
      const z = origin.z + cell / 2 + j * cell;
      let added = 0;
      for (let n = 0; n < rates.length; n += 4) {
        const d2 = (x - rates[n]) ** 2 + (z - rates[n + 1]) ** 2;
        if (d2 <= rates[n + 2] ** 2) {
          added += rates[n + 3];
        }
      }
      const depth = cells[k * 4];
      const inflow = inLeft + inRight + inBack + inFront;
      const outflow = out[0] + out[1] + out[2] + out[3];
      const d = Math.max(
        depth + ((inflow - outflow) * dt) / area + added * dt,
        0,
      );
      const mean = (depth + d) / 2;
      const flowX = (inLeft - out[0] + (out[1] - inRight)) / 2;
      const flowZ = (inBack - out[2] + (out[3] - inFront)) / 2;
      const wet = mean > 1e-3;
      const per = 1 / (Math.max(mean, 0.01) * cell);
      const top = ground[k] + d;
      let occupancy = 0;
      for (const body of bodies) {
        const span = bodySpan(body, x, z);
        if (span) {
          const low = Math.max(span.low, ground[k]);
          occupancy += Math.min(
            parameters.stiffness * Math.max(Math.min(span.high, top) - low, 0),
            Math.max(span.high - low, 0),
          );
        }
      }
      next.set(
        [d, occupancy, wet ? flowX * per : 0, wet ? flowZ * per : 0],
        k * 4,
      );
    }
  }
  state.cells = next;
  state.flux = nextFlux;
}

/** The water of a state, in m³. */
export function waterVolume(state: ShallowState): number {
  let volume = 0;
  for (let k = 0; k < state.cells.length; k += 4) {
    volume += state.cells[k];
  }
  return volume * state.grid.cell * state.grid.cell;
}

/**
 * Reads a field of cells between the four nearest centers (bilinear),
 * clamped to the grid: `value(k)` of the cell k.
 */
export function sampleCells(
  grid: ShallowGrid,
  x: number,
  z: number,
  value: (k: number) => number,
): number {
  const u = Math.min(
    Math.max((x - grid.origin.x) / grid.cell - 0.5, 0),
    grid.nx - 1,
  );
  const v = Math.min(
    Math.max((z - grid.origin.z) / grid.cell - 0.5, 0),
    grid.nz - 1,
  );
  const i = Math.min(Math.floor(u), grid.nx - 2);
  const j = Math.min(Math.floor(v), grid.nz - 2);
  const tx = u - Math.max(i, 0);
  const tz = v - Math.max(j, 0);
  const i0 = Math.max(i, 0);
  const j0 = Math.max(j, 0);
  const i1 = Math.min(i0 + 1, grid.nx - 1);
  const j1 = Math.min(j0 + 1, grid.nz - 1);
  const at = (a: number, b: number) => value(b * grid.nx + a);
  return (
    (at(i0, j0) * (1 - tx) + at(i1, j0) * tx) * (1 - tz) +
    (at(i0, j1) * (1 - tx) + at(i1, j1) * tx) * tz
  );
}

/**
 * The sources as the graphs read them: for each one, its center, the
 * radius of its disc (grown to reach the nearest center of a cell), and
 * the depth it adds per second to each cell whose center is in the disc
 * (its rate over the area of these cells: the volume is exact).
 */
export function sourceRates(
  grid: ShallowGrid,
  sources: readonly WaterSource[],
): Float32Array<ArrayBuffer> {
  const { nx, nz, cell, origin } = grid;
  const data = new Float32Array(Math.max(sources.length, 1) * 4);
  sources.forEach((source, n) => {
    // The cells around the disc.
    const i0 = Math.max(
      Math.floor((source.x - source.radius - origin.x) / cell) - 1,
      0,
    );
    const i1 = Math.min(
      Math.ceil((source.x + source.radius - origin.x) / cell) + 1,
      nx - 1,
    );
    const j0 = Math.max(
      Math.floor((source.z - source.radius - origin.z) / cell) - 1,
      0,
    );
    const j1 = Math.min(
      Math.ceil((source.z + source.radius - origin.z) / cell) + 1,
      nz - 1,
    );
    let count = 0;
    let nearest = Infinity;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const d2 =
          (origin.x + (i + 0.5) * cell - source.x) ** 2 +
          (origin.z + (j + 0.5) * cell - source.z) ** 2;
        nearest = Math.min(nearest, d2);
        if (d2 <= source.radius ** 2) {
          count++;
        }
      }
    }
    // A disc smaller than a cell: its nearest cell.
    const radius = count > 0 ? source.radius : Math.sqrt(nearest) * 1.0001;
    const cells = Math.max(count, 1);
    data.set(
      [
        source.x,
        source.z,
        radius,
        count > 0 || nearest < Infinity
          ? source.rate / (cells * cell * cell)
          : 0,
      ],
      n * 4,
    );
  });
  return data;
}
