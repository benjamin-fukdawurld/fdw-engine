/**
 * The layout of a fluid of particles, as its graphs bake it: the particles,
 * their size, the box they stay in and its cells (of the side of the
 * kernel), the constants of the solver.
 */
export interface ParticleLayout {
  /** The particles, a power of two (the sort needs it). */
  readonly count: number;
  /** The radius of a particle, in meters. */
  readonly radius: number;
  /** The radius of the kernel: 4 radii (two spacings of particles at rest). */
  readonly h: number;
  /** The box the particles stay in. */
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  /** Its cells along x, y and z, of side h. */
  readonly cells: readonly [number, number, number];
  /** The density at rest (the kernel summed over a lattice of spacing 2 radii). */
  readonly restDensity: number;
  /** The sum of the squared gradients of the constraint of a particle at rest. */
  readonly restGradients: number;
  /** The relaxation of the constraints (Macklin's ε), from the rest. */
  readonly relaxation: number;
  /** The particles of a cell at most that a neighbor search visits. */
  readonly maxPerCell: number;
}

/** The poly6 kernel: W(r) = 315 / (64 π h⁹) (h² − r²)³. */
export function poly6(r2: number, h: number): number {
  const h2 = h * h;
  if (r2 >= h2) {
    return 0;
  }
  const d = h2 - r2;
  return (315 / (64 * Math.PI * h ** 9)) * d * d * d;
}

/** The magnitude factor of the gradient of the spiky kernel: ∇W = factor × r (the vector). */
export function spikyGradientFactor(r: number, h: number): number {
  if (r >= h || r <= 1e-9) {
    return 0;
  }
  const d = h - r;
  return ((-45 / (Math.PI * h ** 6)) * d * d) / r;
}

/** The density and the sum of the squared gradients of a particle at the center of a lattice of spacing `spacing`. */
export function latticeRest(
  h: number,
  spacing: number,
): { density: number; gradients: number } {
  let density = 0;
  let gradient = 0;
  const reach = Math.ceil(h / spacing);
  for (let i = -reach; i <= reach; i++) {
    for (let j = -reach; j <= reach; j++) {
      for (let k = -reach; k <= reach; k++) {
        const x = i * spacing;
        const y = j * spacing;
        const z = k * spacing;
        const r2 = x * x + y * y + z * z;
        density += poly6(r2, h);
        const r = Math.sqrt(r2);
        const factor = spikyGradientFactor(r, h);
        gradient += factor * factor * r2;
      }
    }
  }
  return { density, gradients: gradient };
}

/**
 * A layout from its particles and their box: the kernel of 4 radii, cells
 * of its side, the density of a lattice of spacing 2 radii at rest.
 */
export function particleLayout(options: {
  readonly count: number;
  readonly radius: number;
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  readonly relaxation?: number;
  readonly maxPerCell?: number;
}): ParticleLayout {
  const { count, radius } = options;
  if (count < 2 || (count & (count - 1)) !== 0) {
    throw new Error(`The particles must be a power of two: ${count}`);
  }
  const h = 4 * radius;
  const cells = [0, 1, 2].map((a) =>
    Math.max(Math.ceil((options.max[a] - options.min[a]) / h), 1),
  ) as [number, number, number];
  const rest = latticeRest(h, 2 * radius);
  const restGradients = rest.gradients / (rest.density * rest.density);
  return {
    count,
    radius,
    h,
    min: options.min,
    max: options.max,
    cells,
    restDensity: rest.density,
    restGradients,
    // ε, a share of the squared gradients at rest.
    relaxation: (options.relaxation ?? 0.05) * restGradients,
    maxPerCell: options.maxPerCell ?? 48,
  };
}

/** The cell of a point, clamped into the box: its x, y, z. */
export function cellOf(
  layout: ParticleLayout,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  const p = [x, y, z];
  return [0, 1, 2].map((a) =>
    Math.min(
      Math.max(Math.floor((p[a] - layout.min[a]) / layout.h), 0),
      layout.cells[a] - 1,
    ),
  ) as [number, number, number];
}

/** The key of a cell: its index, x first. */
export const cellKey = (
  layout: ParticleLayout,
  c: readonly [number, number, number],
) => (c[2] * layout.cells[1] + c[1]) * layout.cells[0] + c[0];

/** The key of the particles not in use: after every cell. */
export const InactiveKey = 0xffffffff;

/**
 * The stages of a bitonic sort of n elements: (j, k) for each, in order.
 * Each stage puts element i against element i ^ j, in ascending blocks
 * where i & k is 0.
 */
export function bitonicStages(n: number): [number, number][] {
  const stages: [number, number][] = [];
  for (let k = 2; k <= n; k *= 2) {
    for (let j = k / 2; j >= 1; j /= 2) {
      stages.push([j, k]);
    }
  }
  return stages;
}
