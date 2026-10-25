import { simplexNoise } from '@fdw/engine-noise';
import { bodyContact } from '../bodies';
import type { FluidBody } from '../bodies';
import { flickerSpeed } from './graphs';
import type { GridFace, SmokeLayout } from './graphs';
import {
  Axis,
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
  const cellCount = [nx, ny, nz];
  const faces = faceSize(grid);
  const axes = axesOf(grid);
  const open = (axis: Axis, side: -1 | 1) =>
    grid.open.includes(`${side < 0 ? '-' : '+'}${axis}` as GridFace);
  const eachCell = (visit: (c: number[], n: number) => void) => {
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          visit([i, j, k], cellIndex(grid, i, j, k));
        }
      }
    }
  };
  const eachFace = (visit: (c: number[], n: number) => void) => {
    for (let k = 0; k < faces[2]; k++) {
      for (let j = 0; j < faces[1]; j++) {
        for (let i = 0; i < faces[0]; i++) {
          visit([i, j, k], latticeIndex(faces, i, j, k));
        }
      }
    }
  };
  const cellAt = (c: number[]) => cellIndex(grid, c[0], c[1], c[2]);
  const shift = (c: number[], axis: Axis, by: number) => {
    const d = [...c];
    d[axisIndex[axis]] += by;
    return d;
  };
  const center = (c: number[]) => [
    origin.x + (c[0] + 0.5) * cell,
    origin.y + (c[1] + 0.5) * cell,
    origin.z + (c[2] + 0.5) * cell,
  ];
  const sample = new Float32Array(4);
  const velocityAt = (field: Float32Array, p: number[]) => [
    sampleLatticeCpu(
      grid,
      faceLattice(grid, 'x'),
      field,
      p[0],
      p[1],
      p[2],
      sample,
    )[0],
    sampleLatticeCpu(
      grid,
      faceLattice(grid, 'y'),
      field,
      p[0],
      p[1],
      p[2],
      sample,
    )[1],
    flat
      ? 0
      : sampleLatticeCpu(
          grid,
          faceLattice(grid, 'z'),
          field,
          p[0],
          p[1],
          p[2],
          sample,
        )[2],
  ];

  // 1. The obstacles.
  const solids = state.solids;
  eachCell((c, n) => {
    let solid = [0, 0, 0, 0];
    const p = center(c);
    for (const body of bodies) {
      const contact = bodyContact(body, { x: p[0], y: p[1], z: p[2] });
      if (contact.distance < 0) {
        solid = [1, contact.velocity.x, contact.velocity.y, contact.velocity.z];
      }
    }
    solids.set(solid, n * 4);
  });
  const isSolid = (n: number) => solids[n * 4] > 0.5;

  // A face: whether it is one across the axis, its cells, its position.
  const faceOf = (c: number[], axis: Axis) => {
    const a = axisIndex[axis];
    let valid = c[a] <= cellCount[a];
    for (const b of axes) {
      if (b !== axis) {
        valid = valid && c[axisIndex[b]] < cellCount[axisIndex[b]];
      }
    }
    const hasBefore = c[a] > 0;
    const hasAfter = c[a] < cellCount[a];
    const clamped = [
      Math.min(c[0], nx - 1),
      Math.min(c[1], ny - 1),
      Math.min(c[2], nz - 1),
    ];
    const after = cellAt(clamped);
    const before = hasBefore ? cellAt(shift(c, axis, -1)) : after;
    const offset = faceLattice(grid, axis).offset;
    const position = [0, 1, 2].map(
      (b) => [origin.x, origin.y, origin.z][b] + (c[b] + offset[b]) * cell,
    );
    return { valid, hasBefore, hasAfter, before, after, position };
  };
  const constrain = (
    face: ReturnType<typeof faceOf>,
    axis: Axis,
    value: number,
  ) => {
    const component = 1 + axisIndex[axis];
    if (!face.hasBefore) {
      return open(axis, -1) ? value : 0;
    }
    if (!face.hasAfter) {
      return open(axis, 1) ? value : 0;
    }
    if (isSolid(face.after)) {
      return solids[face.after * 4 + component];
    }
    if (isSolid(face.before)) {
      return solids[face.before * 4 + component];
    }
    return value;
  };

  // 2. The advection of the velocity, the forces, the emitters.
  const advected = new Float32Array(state.velocity.length);
  eachFace((c, n) => {
    for (const axis of axes) {
      const face = faceOf(c, axis);
      if (!face.valid) {
        continue;
      }
      const p = face.position;
      const v1 = velocityAt(state.velocity, p);
      const middle = p.map((x, b) => x - v1[b] * dt * 0.5);
      const v2 = velocityAt(state.velocity, middle);
      const from = p.map((x, b) => x - v2[b] * dt);
      const a = axisIndex[axis];
      let value = sampleLatticeCpu(
        grid,
        faceLattice(grid, axis),
        state.velocity,
        from[0],
        from[1],
        from[2],
        sample,
      )[a];
      if (axis === 'y') {
        const here = sampleLatticeCpu(
          grid,
          cellLattice(grid),
          state.scalars,
          p[0],
          p[1],
          p[2],
          sample,
        );
        value +=
          (parameters.buoyancy * here[1] - parameters.weight * here[0]) * dt;
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
            Math.hypot(p[0] - e.x, p[1] - e.y, p[2] - e.z),
          );
        blown += [e.velocity.x, e.velocity.y, e.velocity.z][a] * s;
        weight += s;
      }
      const blowing = Math.min(weight, 1);
      value += (blown / Math.max(weight, 1e-6) - value) * blowing;
      advected[n * 4 + a] = constrain(face, axis, value);
    }
  });

  // 3. The advection of the scalars, the emitters.
  const scalars = new Float32Array(state.scalars.length);
  eachCell((c, n) => {
    if (isSolid(n)) {
      return;
    }
    const p = center(c);
    const v1 = velocityAt(state.velocity, p);
    const middle = p.map((x, b) => x - v1[b] * dt * 0.5);
    const v2 = velocityAt(state.velocity, middle);
    const from = p.map((x, b) => x - v2[b] * dt);
    const carried = sampleLatticeCpu(
      grid,
      cellLattice(grid),
      state.scalars,
      from[0],
      from[1],
      from[2],
      sample,
    );
    let poured = 0;
    let heat = 0;
    for (const e of emitters) {
      const noise = simplexNoise([
        (p[0] * 2) / e.radius,
        (p[1] * 2) / e.radius - time * flickerSpeed,
        (p[2] * 2) / e.radius,
      ]);
      const flicker = 1 - (e.turbulence ?? 0) * (noise * 0.5 + 0.5);
      const s =
        (1 -
          smoothstep(
            e.radius * 0.5,
            e.radius,
            Math.hypot(p[0] - e.x, p[1] - e.y, p[2] - e.z),
          )) *
        flicker;
      poured += e.density * s * dt;
      heat = Math.max(heat, e.temperature * s);
    }
    scalars[n * 4] = (carried[0] + poured) / (1 + dt * parameters.densityDecay);
    scalars[n * 4 + 1] =
      Math.max(carried[1], heat) / (1 + dt * parameters.cooling);
  });
  state.scalars = scalars;

  // The velocity at the center of a cell; the neighbor of a cell, itself
  // past an edge.
  const centerVelocity = (field: Float32Array, c: number[]) =>
    (['x', 'y', 'z'] as const).map((axis) => {
      if (flat && axis === 'z') {
        return 0;
      }
      const a = axisIndex[axis];
      const high = shift(c, axis, 1);
      return (
        (field[latticeIndex(faces, c[0], c[1], c[2]) * 4 + a] +
          field[latticeIndex(faces, high[0], high[1], high[2]) * 4 + a]) /
        2
      );
    });
  const neighborCell = (c: number[], axis: Axis, side: -1 | 1) => {
    const a = axisIndex[axis];
    const at = c[a] + side;
    return at >= 0 && at < cellCount[a] ? shift(c, axis, side) : c;
  };

  // 4. The vorticity.
  const vorticity = state.vorticity;
  eachCell((c, n) => {
    const d = (axis: Axis) => {
      const after = centerVelocity(advected, neighborCell(c, axis, 1));
      const before = centerVelocity(advected, neighborCell(c, axis, -1));
      return after.map((v, b) => (v - before[b]) / (2 * cell));
    };
    const dx = d('x');
    const dy = d('y');
    let curl: number[];
    if (flat) {
      curl = [0, 0, dx[1] - dy[0]];
    } else {
      const dz = d('z');
      curl = [dy[2] - dz[1], dz[0] - dx[2], dx[1] - dy[0]];
    }
    vorticity.set([...curl, Math.hypot(curl[0], curl[1], curl[2])], n * 4);
  });

  // 5. The confinement.
  const force = (c: number[]) => {
    const norm = (axis: Axis, side: -1 | 1) =>
      vorticity[cellAt(neighborCell(c, axis, side)) * 4 + 3];
    const gradient = [
      norm('x', 1) - norm('x', -1),
      norm('y', 1) - norm('y', -1),
      flat ? 0 : norm('z', 1) - norm('z', -1),
    ];
    const length = Math.max(
      Math.hypot(gradient[0], gradient[1], gradient[2]),
      1e-6,
    );
    const g = gradient.map((v) => v / length);
    const n = cellAt(c) * 4;
    const w = [vorticity[n], vorticity[n + 1], vorticity[n + 2]];
    const scale = parameters.vorticity * cell;
    return [
      (g[1] * w[2] - g[2] * w[1]) * scale,
      (g[2] * w[0] - g[0] * w[2]) * scale,
      (g[0] * w[1] - g[1] * w[0]) * scale,
    ];
  };
  const confined = new Float32Array(advected.length);
  eachFace((c, n) => {
    const after = [
      Math.min(c[0], nx - 1),
      Math.min(c[1], ny - 1),
      Math.min(c[2], nz - 1),
    ];
    const here = force(after);
    for (const axis of axes) {
      const face = faceOf(c, axis);
      if (!face.valid) {
        continue;
      }
      const a = axisIndex[axis];
      const before = force(neighborCell(after, axis, -1));
      const value = advected[n * 4 + a] + ((here[a] + before[a]) / 2) * dt;
      confined[n * 4 + a] = constrain(face, axis, value);
    }
  });

  // 6. The divergence, the pressure from the last frame.
  const pressure = new Float32Array(state.pressure.length);
  eachCell((c, n) => {
    let divergence = 0;
    for (const axis of axes) {
      const a = axisIndex[axis];
      const high = shift(c, axis, 1);
      divergence +=
        confined[latticeIndex(faces, high[0], high[1], high[2]) * 4 + a] -
        confined[latticeIndex(faces, c[0], c[1], c[2]) * 4 + a];
    }
    pressure[n * 4] = state.pressure[n * 4];
    pressure[n * 4 + 1] = divergence / cell;
  });

  // 7. The pressure.
  let current = pressure;
  for (let iteration = 0; iteration < parameters.iterations; iteration++) {
    const next = new Float32Array(current.length);
    eachCell((c, n) => {
      let sum = 0;
      let count = 0;
      for (const axis of axes) {
        for (const side of [-1, 1] as const) {
          const a = axisIndex[axis];
          const at = c[a] + side;
          if (at < 0 || at >= cellCount[a]) {
            count += open(axis, side) ? 1 : 0;
            continue;
          }
          const m = cellAt(shift(c, axis, side));
          if (!isSolid(m)) {
            sum += current[m * 4];
            count++;
          }
        }
      }
      next[n * 4] =
        count > 0 ? (sum - current[n * 4 + 1] * cell * cell) / count : 0;
      next[n * 4 + 1] = current[n * 4 + 1];
    });
    current = next;
  }
  state.pressure = current;

  // 8. The projection.
  const projected = new Float32Array(confined.length);
  eachFace((c, n) => {
    for (const axis of axes) {
      const face = faceOf(c, axis);
      if (!face.valid) {
        continue;
      }
      const a = axisIndex[axis];
      const after = face.hasAfter ? current[face.after * 4] : 0;
      const before = face.hasBefore ? current[face.before * 4] : 0;
      projected[n * 4 + a] = constrain(
        face,
        axis,
        confined[n * 4 + a] - (after - before) / cell,
      );
    }
  });
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
  const d = [sun.x / length, sun.y / length, sun.z / length];
  const shade = new Float32Array(nx * ny * nz * 4);
  const sample = new Float32Array(4);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const n = cellIndex(grid, i, j, k);
        const c = [
          origin.x + (i + 0.5) * cell,
          origin.y + (j + 0.5) * cell,
          origin.z + (k + 0.5) * cell,
        ];
        let total = 0;
        for (let s = 0; s < steps; s++) {
          const t = (s + 0.5) * cell;
          total += sampleLatticeCpu(
            grid,
            cellLattice(grid),
            state.scalars,
            c[0] + d[0] * t,
            c[1] + d[1] * t,
            c[2] + d[2] * t,
            sample,
            'zero',
          )[0];
        }
        shade.set(
          [
            state.scalars[n * 4],
            Math.exp(-total * cell * extinction),
            state.scalars[n * 4 + 1],
            0,
          ],
          n * 4,
        );
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
