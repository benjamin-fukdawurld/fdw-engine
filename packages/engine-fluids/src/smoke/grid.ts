import type { Ops } from '@fdw/engine-ocean';
import { BuiltinTypes } from '@fdw/engine-shader';
import type { PortHandle } from '@fdw/engine-shader';

/** A grid of cubic cells in the world, as the graphs bake it. */
export interface VolumeGrid {
  readonly nx: number;
  readonly ny: number;
  /** 1 for a grid in a plane (2D): x and y. */
  readonly nz: number;
  /** The side of a cell, in meters. */
  readonly cell: number;
  /** The corner of the grid in the world: cell (0, 0, 0) spans it to + cell. */
  readonly origin: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  };
}

export const axes = ['x', 'y', 'z'] as const;
export type Axis = (typeof axes)[number];
export const axisIndex = { x: 0, y: 1, z: 2 } as const;

/** Whether a grid is flat (2D): one cell along z. */
export const isFlat = (grid: VolumeGrid) => grid.nz === 1;

/** The axes of a grid: three, two in a plane. */
export const axesOf = (grid: VolumeGrid): readonly Axis[] =>
  isFlat(grid) ? ['x', 'y'] : axes;

/**
 * A lattice of values in a buffer: the cells themselves, or the faces of
 * the cells across one axis (the velocities of a staggered grid). Its
 * entries along each axis, where the value of entry (0, 0, 0) is in the
 * world (in cells from the origin), and the last entry holding a value
 * along each axis.
 */
export interface Lattice {
  readonly size: readonly [number, number, number];
  readonly offset: readonly [number, number, number];
  readonly last: readonly [number, number, number];
}

/** The lattice of the cells of a grid: a value at each center. */
export const cellLattice = (grid: VolumeGrid): Lattice => ({
  size: [grid.nx, grid.ny, grid.nz],
  offset: [0.5, 0.5, 0.5],
  last: [grid.nx - 1, grid.ny - 1, grid.nz - 1],
});

/**
 * The size of the buffer of faces of a grid: one entry more along each axis
 * (the far faces), but along z in a plane.
 */
export const faceSize = (grid: VolumeGrid): [number, number, number] => [
  grid.nx + 1,
  grid.ny + 1,
  isFlat(grid) ? 1 : grid.nz + 1,
];

/**
 * The lattice of the faces across an axis: entry (i, j, k) is the face on
 * the low side of cell (i, j, k), at its center; along the axis there is
 * one face more than cells.
 */
export function faceLattice(grid: VolumeGrid, axis: Axis): Lattice {
  const size = faceSize(grid);
  const a = axisIndex[axis];
  const cells = [grid.nx, grid.ny, grid.nz];
  return {
    size,
    offset: [a === 0 ? 0 : 0.5, a === 1 ? 0 : 0.5, a === 2 ? 0 : 0.5],
    last: [0, 1, 2].map((b) => (b === a ? cells[b] : cells[b] - 1)) as [
      number,
      number,
      number,
    ],
  };
}

/** The workgroup size of the graphs of a grid. */
export const volumeWorkgroup = (grid: VolumeGrid) =>
  (isFlat(grid) ? [8, 8, 1] : [4, 4, 4]) as [number, number, number];

/** The workgroups of a dispatch over `size` entries. */
export function volumeWorkgroups(
  grid: VolumeGrid,
  size: readonly [number, number, number] = [grid.nx, grid.ny, grid.nz],
): [number, number, number] {
  const group = volumeWorkgroup(grid);
  return [
    Math.ceil(size[0] / group[0]),
    Math.ceil(size[1] / group[1]),
    Math.ceil(size[2] / group[2]),
  ];
}

/** The index of entry (i, j, k) of a buffer of `size` entries, on the CPU. */
export const latticeIndex = (
  size: readonly [number, number, number],
  i: number,
  j: number,
  k: number,
) => (k * size[1] + j) * size[0] + i;

/** The index of cell (i, j, k), on the CPU. */
export const cellIndex = (grid: VolumeGrid, i: number, j: number, k: number) =>
  (k * grid.ny + j) * grid.nx + i;

/** a && b, for booleans: the graphs have no logical operators. */
export const and = (o: Ops, a: PortHandle, b: PortHandle) =>
  o.select(false, b, a);
/** a || b, for booleans. */
export const or = (o: Ops, a: PortHandle, b: PortHandle) =>
  o.select(b, true, a);

/** The thread of a graph over a buffer of `size` entries: its coordinates, index, whether it is in. */
export function latticeThread(o: Ops, size: readonly [number, number, number]) {
  const id = o.g.builtin('global-invocation-id');
  const i = id.swizzle('x');
  const j = id.swizzle('y');
  const k = id.swizzle('z');
  const index = o.add(o.mul(o.add(o.mul(k, size[1]), j), size[0]), i);
  const inside = and(
    o,
    and(o, o.less(i, size[0]), o.less(j, size[1])),
    o.less(k, size[2]),
  );
  return { id, i, j, k, index, inside, coordinate: { x: i, y: j, z: k } };
}

/** The index of entry `ijk` (vec3u) of a buffer of `size` entries, in a graph. */
export const latticeIndexInGraph = (
  o: Ops,
  size: readonly [number, number, number],
  ijk: PortHandle,
) =>
  o.add(
    o.mul(o.add(o.mul(ijk.swizzle('z'), size[1]), ijk.swizzle('y')), size[0]),
    ijk.swizzle('x'),
  );

/**
 * Reads a lattice of vec4 at a point of the world, between its nearest
 * entries (trilinear; bilinear in a plane), clamped to its entries; 0 out
 * of the box of the grid with `outside: 'zero'`.
 */
export function sampleLattice(
  o: Ops,
  grid: VolumeGrid,
  lattice: Lattice,
  values: PortHandle,
  point: PortHandle,
  outside: 'clamp' | 'zero' = 'clamp',
): PortHandle {
  const flat = isFlat(grid);
  const [lx, ly, lz] = lattice.last;
  const uvw = o.clamp(
    o.sub(
      o.div(
        o.sub(point, [grid.origin.x, grid.origin.y, grid.origin.z]),
        grid.cell,
      ),
      [...lattice.offset],
    ),
    [0, 0, 0],
    [lx, ly, lz],
  );
  const base = o.min(o.floor(uvw), [
    Math.max(lx - 1, 0),
    Math.max(ly - 1, 0),
    Math.max(lz - 1, 0),
  ]);
  const t = o.sub(uvw, base);
  const ijk = o.convert(base, BuiltinTypes.vec3u);
  const at = (di: number, dj: number, dk: number) =>
    o.index(
      values,
      latticeIndexInGraph(
        o,
        lattice.size,
        o.add(ijk, o.g.constant(BuiltinTypes.vec3u, [di, dj, dk])),
      ),
    );
  const plane = (dk: number) =>
    o.mix(
      o.mix(at(0, 0, dk), at(1, 0, dk), t.swizzle('x')),
      o.mix(at(0, 1, dk), at(1, 1, dk), t.swizzle('x')),
      t.swizzle('y'),
    );
  const value =
    flat || lz === 0 ? plane(0) : o.mix(plane(0), plane(1), t.swizzle('z'));
  if (outside === 'clamp') {
    return value;
  }
  const size = [grid.nx, grid.ny, grid.nz].map((n) => n * grid.cell);
  const local = o.sub(point, [grid.origin.x, grid.origin.y, grid.origin.z]);
  const within = (axis: Axis) =>
    and(
      o,
      o.greaterEqual(local.swizzle(axis), 0),
      o.lessEqual(local.swizzle(axis), size[axisIndex[axis]]),
    );
  const inBox = and(
    o,
    within('x'),
    flat ? within('y') : and(o, within('y'), within('z')),
  );
  return o.select([0, 0, 0, 0], value, inBox);
}

/** Reads the cells of a grid at a point (see {@link sampleLattice}). */
export const sampleVolume = (
  o: Ops,
  grid: VolumeGrid,
  cells: PortHandle,
  point: PortHandle,
  outside: 'clamp' | 'zero' = 'clamp',
) => sampleLattice(o, grid, cellLattice(grid), cells, point, outside);

/** The same read on the CPU: the vec4 of the lattice at a point. */
export function sampleLatticeCpu(
  grid: VolumeGrid,
  lattice: Lattice,
  values: Float32Array,
  x: number,
  y: number,
  z: number,
  out: Float32Array = new Float32Array(4),
  outside: 'clamp' | 'zero' = 'clamp',
): Float32Array {
  const flat = isFlat(grid);
  if (outside === 'zero') {
    const lx = x - grid.origin.x;
    const ly = y - grid.origin.y;
    const lz = z - grid.origin.z;
    if (
      lx < 0 ||
      ly < 0 ||
      lx > grid.nx * grid.cell ||
      ly > grid.ny * grid.cell ||
      (!flat && (lz < 0 || lz > grid.nz * grid.cell))
    ) {
      return out.fill(0);
    }
  }
  const p = [x - grid.origin.x, y - grid.origin.y, z - grid.origin.z];
  const uvw = [0, 1, 2].map((a) =>
    Math.min(
      Math.max(p[a] / grid.cell - lattice.offset[a], 0),
      lattice.last[a],
    ),
  );
  const base = [0, 1, 2].map((a) =>
    Math.min(Math.floor(uvw[a]), Math.max(lattice.last[a] - 1, 0)),
  );
  const t = [0, 1, 2].map((a) => uvw[a] - base[a]);
  const third = flat || lattice.last[2] === 0;
  out.fill(0);
  for (let dk = 0; dk <= (third ? 0 : 1); dk++) {
    for (let dj = 0; dj <= 1; dj++) {
      for (let di = 0; di <= 1; di++) {
        const weight =
          (di ? t[0] : 1 - t[0]) *
          (dj ? t[1] : 1 - t[1]) *
          (third ? 1 : dk ? t[2] : 1 - t[2]);
        if (weight === 0) {
          continue;
        }
        const at =
          latticeIndex(lattice.size, base[0] + di, base[1] + dj, base[2] + dk) *
          4;
        for (let c = 0; c < 4; c++) {
          out[c] += values[at + c] * weight;
        }
      }
    }
  }
  return out;
}

/** Reads the cells of a grid at a point, on the CPU. */
export const sampleVolumeCpu = (
  grid: VolumeGrid,
  cells: Float32Array,
  x: number,
  y: number,
  z: number,
  out: Float32Array = new Float32Array(4),
  outside: 'clamp' | 'zero' = 'clamp',
) => sampleLatticeCpu(grid, cellLattice(grid), cells, x, y, z, out, outside);
