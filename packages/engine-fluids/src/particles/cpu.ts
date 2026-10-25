import { bodyContact } from '../bodies';
import type { FluidBody } from '../bodies';
import {
  cellKey,
  cellOf,
  InactiveKey,
  ParticleLayout,
  poly6,
  spikyGradientFactor,
} from './kernels';

/** The constants of a step of particles. */
export interface ParticleParameters {
  /** In m/s², downward (9.81). */
  readonly gravity: number;
  /** The solver iterations of a step (4): fewer let a splash against a wall blow up. */
  readonly iterations: number;
  /** The XSPH viscosity, from 0 (none) to about 0.1 (0.02). */
  readonly viscosity: number;
  /**
   * The artificial pressure that keeps the particles from clumping at the
   * surface (Macklin's s_corr, as a share of the rest density): 0.03. More
   * pushes the particles apart where they crowd against a wall: a splash
   * blows up.
   */
  readonly tensile: number;
  /** The fastest a particle goes, in m/s (8). */
  readonly maxSpeed: number;
}

/** The particles on the CPU: what the buffers hold (vec4 each), and how many are in use. */
export interface ParticleState {
  readonly layout: ParticleLayout;
  positions: Float32Array;
  velocities: Float32Array;
  active: number;
}

/** The density at Δq = 0.2 h, for the artificial pressure. */
export const tensileDistance = 0.2;

/** Moves a point out of the walls of the box and out of the bodies, by the radius of a particle. */
export function collide(
  layout: ParticleLayout,
  bodies: readonly FluidBody[],
  p: number[],
): void {
  const r = layout.radius;
  for (const body of bodies) {
    const contact = bodyContact(body, { x: p[0], y: p[1], z: p[2] });
    const depth = contact.distance - r;
    if (depth < 0) {
      p[0] -= contact.normal.x * depth;
      p[1] -= contact.normal.y * depth;
      p[2] -= contact.normal.z * depth;
    }
  }
  for (let a = 0; a < 3; a++) {
    p[a] = Math.min(Math.max(p[a], layout.min[a] + r), layout.max[a] - r);
  }
}

/**
 * A step of the particles on the CPU: the same passes as the compute graphs
 * (prediction, sort by cell, constraints of density, velocities, viscosity),
 * for the tests. The particles come out in the order of their cells.
 */
export function stepParticles(
  state: ParticleState,
  dt: number,
  parameters: ParticleParameters,
  bodies: readonly FluidBody[] = [],
): void {
  const layout = state.layout;
  const n = layout.count;
  const { h, restDensity: rho0 } = layout;
  const active = state.active;
  // 1. The prediction.
  const predicted = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const p = [
      state.positions[i * 4],
      state.positions[i * 4 + 1],
      state.positions[i * 4 + 2],
    ];
    if (i < active) {
      const v = [
        state.velocities[i * 4],
        state.velocities[i * 4 + 1] - parameters.gravity * dt,
        state.velocities[i * 4 + 2],
      ];
      p[0] += v[0] * dt;
      p[1] += v[1] * dt;
      p[2] += v[2] * dt;
      collide(layout, bodies, p);
    }
    predicted.set([p[0], p[1], p[2], 0], i * 4);
  }
  // 2. The sort by cell, the ranges of the cells.
  const keys = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    keys[i] =
      i < active
        ? cellKey(
            layout,
            cellOf(
              layout,
              predicted[i * 4],
              predicted[i * 4 + 1],
              predicted[i * 4 + 2],
            ),
          )
        : InactiveKey;
  }
  const order = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => keys[a] - keys[b] || a - b,
  );
  const cellCount = layout.cells[0] * layout.cells[1] * layout.cells[2];
  const starts = new Uint32Array(cellCount);
  const ends = new Uint32Array(cellCount);
  order.forEach((index, i) => {
    const key = keys[index];
    if (key === InactiveKey) {
      return;
    }
    if (i === 0 || keys[order[i - 1]] !== key) {
      starts[key] = i;
    }
    if (i === n - 1 || keys[order[i + 1]] !== key) {
      ends[key] = i + 1;
    }
  });
  // 3. The particles in that order.
  const permute = (values: Float32Array) => {
    const out = new Float32Array(values.length);
    order.forEach((index, i) =>
      out.set(values.subarray(index * 4, index * 4 + 4), i * 4),
    );
    return out;
  };
  const positions = permute(state.positions);
  const velocities = permute(state.velocities);
  let current = permute(predicted);

  // The neighbors of a point: each particle j of the 27 cells around.
  const neighbors = (
    p: Float32Array | number[],
    visit: (j: number) => void,
  ) => {
    const c = cellOf(layout, p[0], p[1], p[2]);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const cell: [number, number, number] = [
            c[0] + dx,
            c[1] + dy,
            c[2] + dz,
          ];
          if (cell.some((v, a) => v < 0 || v >= layout.cells[a])) {
            continue;
          }
          const key = cellKey(layout, cell);
          const end = Math.min(ends[key], starts[key] + layout.maxPerCell);
          for (let j = starts[key]; j < end; j++) {
            visit(j);
          }
        }
      }
    }
  };
  const tensileReference = poly6((tensileDistance * h) ** 2, h);
  // 4. The constraints of density.
  for (let iteration = 0; iteration < parameters.iterations; iteration++) {
    const lambdas = new Float32Array(n);
    for (let i = 0; i < active; i++) {
      const p = current.subarray(i * 4, i * 4 + 3);
      let density = 0;
      const gradient = [0, 0, 0];
      let squares = 0;
      neighbors(p, (j) => {
        const r = [
          p[0] - current[j * 4],
          p[1] - current[j * 4 + 1],
          p[2] - current[j * 4 + 2],
        ];
        const r2 = r[0] * r[0] + r[1] * r[1] + r[2] * r[2];
        density += poly6(r2, h);
        const factor = spikyGradientFactor(Math.sqrt(r2), h) / rho0;
        gradient[0] += factor * r[0];
        gradient[1] += factor * r[1];
        gradient[2] += factor * r[2];
        squares += factor * factor * r2;
      });
      const constraint = Math.max(density / rho0 - 1, 0);
      const total =
        gradient[0] * gradient[0] +
        gradient[1] * gradient[1] +
        gradient[2] * gradient[2] +
        squares;
      lambdas[i] = -constraint / (total + layout.relaxation);
    }
    const next = current.slice();
    for (let i = 0; i < active; i++) {
      const p = current.subarray(i * 4, i * 4 + 3);
      const delta = [0, 0, 0];
      neighbors(p, (j) => {
        const r = [
          p[0] - current[j * 4],
          p[1] - current[j * 4 + 1],
          p[2] - current[j * 4 + 2],
        ];
        const r2 = r[0] * r[0] + r[1] * r[1] + r[2] * r[2];
        const ratio = poly6(r2, h) / tensileReference;
        const corrective =
          (-parameters.tensile * ratio ** 4) / layout.restGradients;
        const factor =
          ((lambdas[i] + lambdas[j] + corrective) *
            spikyGradientFactor(Math.sqrt(r2), h)) /
          rho0;
        delta[0] += factor * r[0];
        delta[1] += factor * r[1];
        delta[2] += factor * r[2];
      });
      const moved = [p[0] + delta[0], p[1] + delta[1], p[2] + delta[2]];
      collide(layout, bodies, moved);
      next.set(moved, i * 4);
    }
    current = next;
  }
  // 5. The velocities, then the viscosity.
  const raw = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    if (i < active) {
      for (let a = 0; a < 3; a++) {
        raw[i * 4 + a] = (current[i * 4 + a] - positions[i * 4 + a]) / dt;
      }
    } else {
      raw.set(velocities.subarray(i * 4, i * 4 + 4), i * 4);
    }
  }
  const final = raw.slice();
  for (let i = 0; i < active; i++) {
    const p = current.subarray(i * 4, i * 4 + 3);
    const v = raw.subarray(i * 4, i * 4 + 3);
    const sum = [0, 0, 0];
    neighbors(p, (j) => {
      const r = [
        p[0] - current[j * 4],
        p[1] - current[j * 4 + 1],
        p[2] - current[j * 4 + 2],
      ];
      const w = poly6(r[0] * r[0] + r[1] * r[1] + r[2] * r[2], h) / rho0;
      sum[0] += (raw[j * 4] - v[0]) * w;
      sum[1] += (raw[j * 4 + 1] - v[1]) * w;
      sum[2] += (raw[j * 4 + 2] - v[2]) * w;
    });
    const out = [0, 1, 2].map((a) => v[a] + parameters.viscosity * sum[a]);
    const speed = Math.hypot(out[0], out[1], out[2]);
    const scale = speed > parameters.maxSpeed ? parameters.maxSpeed / speed : 1;
    final.set([out[0] * scale, out[1] * scale, out[2] * scale, 0], i * 4);
  }
  // The inactive particles keep their place.
  for (let i = active; i < n; i++) {
    current.set(positions.subarray(i * 4, i * 4 + 4), i * 4);
  }
  state.positions = current;
  state.velocities = final;
}

/** The density of each particle in use, over the rest density (for the tests). */
export function particleDensities(state: ParticleState): Float32Array {
  const layout = state.layout;
  const out = new Float32Array(state.active);
  for (let i = 0; i < state.active; i++) {
    let density = 0;
    for (let j = 0; j < state.active; j++) {
      const r2 =
        (state.positions[i * 4] - state.positions[j * 4]) ** 2 +
        (state.positions[i * 4 + 1] - state.positions[j * 4 + 1]) ** 2 +
        (state.positions[i * 4 + 2] - state.positions[j * 4 + 2]) ** 2;
      density += poly6(r2, layout.h);
    }
    out[i] = density / layout.restDensity;
  }
  return out;
}

/** Particles on a lattice of spacing 2 radii filling a box, up to `limit`: x, y, z, 0 each. */
export function particleBlock(
  layout: ParticleLayout,
  min: readonly [number, number, number],
  max: readonly [number, number, number],
  limit = Infinity,
): Float32Array {
  const spacing = 2 * layout.radius;
  const points: number[] = [];
  for (
    let y = min[1] + layout.radius;
    y <= max[1] - layout.radius + 1e-6;
    y += spacing
  ) {
    for (
      let z = min[2] + layout.radius;
      z <= max[2] - layout.radius + 1e-6;
      z += spacing
    ) {
      for (
        let x = min[0] + layout.radius;
        x <= max[0] - layout.radius + 1e-6;
        x += spacing
      ) {
        if (points.length / 4 >= limit) {
          return new Float32Array(points);
        }
        points.push(x, y, z, 0);
      }
    }
  }
  return new Float32Array(points);
}
