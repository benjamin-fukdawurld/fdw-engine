import { Aabb } from '@fdw/engine-geometry';

/** A corner of a patch: its position, normal and uv, in object space. */
export interface PatchCorner {
  readonly position: readonly [number, number, number];
  readonly normal: readonly [number, number, number];
  readonly uv: readonly [number, number];
}

/**
 * A quad patch, by its corners at (s, t) = (0, 0), (1, 0), (0, 1), (1, 1).
 * The surface is the bilinear interpolation of the corners; its front face
 * is on the side of (c01 − c00) × (c10 − c00).
 */
export type Patch = readonly [
  PatchCorner,
  PatchCorner,
  PatchCorner,
  PatchCorner
];

/** The finest template: 2^6 = 64 quads along each edge of a patch. */
export const MaxLevel = 6;

/** The texels of a patch in the patch texture (rgba32float). */
export const TexelsPerPatch = 8;
/** The width of the patch textures. */
export const PatchTextureWidth = 256;
/** The patches on a row of the patch texture. */
export const PatchesPerRow = PatchTextureWidth / TexelsPerPatch;

/**
 * The patches of a surface, ready for the GPU: their corners in the layout
 * of the patch texture, and their edges, each shared by the patches on both
 * sides. Two neighbors must share the corners of their common edge (the
 * same positions); in the same direction, the seam is exact to the bit.
 */
export class Patches {
  readonly count: number;
  /**
   * The patch texture: 8 texels a patch, 32 patches a row. Texels 0 to 3:
   * the position of each corner and its u; 4 to 7: its normal and its v.
   */
  readonly data: Float32Array<ArrayBuffer>;
  /** The rows of the patch texture. */
  readonly rows: number;
  /** The 4 edges of each patch: t = 0, s = 1, t = 1, s = 0. */
  readonly edges: Uint32Array;
  /** The ends of each edge, in object space: 6 numbers an edge. */
  readonly edgeEnds: Float64Array;
  /** The box of each patch, before displacement: min then max. */
  readonly boxes: Float64Array;
  /** The box of all the patches, before displacement. */
  readonly bounds: Aabb;

  constructor(patches: readonly Patch[]) {
    if (patches.length === 0) {
      throw new Error('A surface needs at least one patch');
    }
    this.count = patches.length;
    this.rows = Math.ceil(patches.length / PatchesPerRow);
    this.data = new Float32Array(this.rows * PatchTextureWidth * 4);
    this.edges = new Uint32Array(patches.length * 4);
    this.boxes = new Float64Array(patches.length * 6);
    this.bounds = Aabb.empty();

    const edgeIndex = new Map<string, number>();
    const ends: number[] = [];
    const key = (p: readonly number[]) => `${p[0]},${p[1]},${p[2]}`;
    const edgeOf = (a: PatchCorner, b: PatchCorner) => {
      // The same edge whichever patch, whichever direction.
      const [first, second] =
        key(a.position) < key(b.position) ? [a, b] : [b, a];
      const name = `${key(first.position)}|${key(second.position)}`;
      let index = edgeIndex.get(name);
      if (index === undefined) {
        index = edgeIndex.size;
        edgeIndex.set(name, index);
        ends.push(...first.position, ...second.position);
      }
      return index;
    };

    const box = new Aabb();
    patches.forEach((patch, p) => {
      const base = p * TexelsPerPatch * 4;
      box.makeEmpty();
      patch.forEach((corner, c) => {
        this.data.set([...corner.position, corner.uv[0]], base + c * 4);
        this.data.set([...corner.normal, corner.uv[1]], base + 16 + c * 4);
        box.expandByPoint(corner.position);
      });
      this.boxes.set([...box.min, ...box.max], p * 6);
      this.bounds.union(box);
      const [c00, c10, c01, c11] = patch;
      this.edges.set(
        [
          edgeOf(c00, c10),
          edgeOf(c10, c11),
          edgeOf(c01, c11),
          edgeOf(c00, c01),
        ],
        p * 4
      );
    });
    this.edgeEnds = new Float64Array(ends);
  }

  /** The number of edges, each counted once. */
  get edgeCount(): number {
    return this.edgeEnds.length / 6;
  }
}

/**
 * A flat grid of patches in the XZ plane, centered on the origin, facing
 * +Y: a terrain, a wall once turned. The uv go from 0 to 1 over the grid,
 * u along +X, v along +Z.
 */
export function patchGrid({
  width,
  depth,
  columns,
  rows,
}: {
  // The size of the grid along X and Z.
  width: number;
  depth: number;
  // The patches along X and Z.
  columns: number;
  rows: number;
}): Patches {
  const corner = (i: number, j: number): PatchCorner => {
    const u = i / columns;
    const v = j / rows;
    return {
      position: [(u - 0.5) * width, 0, (v - 0.5) * depth],
      normal: [0, 1, 0],
      uv: [u, v],
    };
  };
  const patches: Patch[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      patches.push([
        corner(i, j),
        corner(i + 1, j),
        corner(i, j + 1),
        corner(i + 1, j + 1),
      ]);
    }
  }
  return new Patches(patches);
}
