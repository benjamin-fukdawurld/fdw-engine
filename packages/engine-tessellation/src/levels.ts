import type { Frustum, Matrix4 } from '@fdw/engine-geometry';
import { MaxLevel, Patches } from './patches';

/** How the levels are chosen: see {@link PatchSurfaceOptions}. */
export interface LevelOptions {
  // The length of the edges of the triangles on the screen, in pixels.
  readonly edgePixels: number;
  readonly minLevel: number;
  readonly maxLevel: number;
  // How far the displacement moves a point, at most, in world units: the
  // boxes of the patches grow by it.
  readonly grow: number;
}

/** Where the patches are seen from. */
export interface LevelView {
  readonly position: readonly [number, number, number];
  // Pixels per world unit at a distance of 1 (perspective), or at any
  // distance (orthographic).
  readonly pixelScale: number;
  readonly orthographic: boolean;
  // The patches outside of it are not drawn.
  readonly frustum?: Frustum;
}

/**
 * The levels of a frame: of each edge, and of each patch (-1 when culled),
 * with the number of patches at each level.
 */
export class LevelSelection {
  readonly edgeLevels: Uint8Array;
  readonly levels: Int8Array;
  readonly counts = new Uint32Array(MaxLevel + 1);
  private readonly _ends: Float64Array;
  private readonly _boxes: Float64Array;

  constructor(readonly patches: Patches) {
    this.edgeLevels = new Uint8Array(patches.edgeCount);
    this.levels = new Int8Array(patches.count);
    this._ends = new Float64Array(patches.edgeEnds.length);
    this._boxes = new Float64Array(patches.boxes.length);
  }

  /** The patches drawn. */
  get drawn(): number {
    return this.counts.reduce((sum, count) => sum + count, 0);
  }

  /**
   * Chooses the levels: each edge by its length on the screen, seen from
   * its closest point; each patch at the finest level of its edges. An
   * edge has one level for both of its patches: no crack between them.
   */
  update(world: Matrix4, view: LevelView, options: LevelOptions): this {
    const { patches, edgeLevels, levels, counts } = this;
    const ends = this._ends;
    transformPoints(patches.edgeEnds, world, ends);

    const [cx, cy, cz] = view.position;
    const perPixel = view.pixelScale / options.edgePixels;
    for (let edge = 0; edge < edgeLevels.length; edge++) {
      const i = edge * 6;
      const dx = ends[i + 3] - ends[i];
      const dy = ends[i + 4] - ends[i + 1];
      const dz = ends[i + 5] - ends[i + 2];
      const lengthSquared = dx * dx + dy * dy + dz * dz;
      let distance = 1;
      if (!view.orthographic) {
        // The closest point of the edge to the camera.
        const along =
          lengthSquared > 0
            ? Math.min(
                Math.max(
                  ((cx - ends[i]) * dx +
                    (cy - ends[i + 1]) * dy +
                    (cz - ends[i + 2]) * dz) /
                    lengthSquared,
                  0
                ),
                1
              )
            : 0;
        const px = ends[i] + dx * along - cx;
        const py = ends[i + 1] + dy * along - cy;
        const pz = ends[i + 2] + dz * along - cz;
        distance = Math.max(Math.sqrt(px * px + py * py + pz * pz), 1e-6);
      }
      const segments = (Math.sqrt(lengthSquared) * perPixel) / distance;
      const level = segments > 1 ? Math.ceil(Math.log2(segments)) : 0;
      edgeLevels[edge] = Math.min(
        Math.max(level, options.minLevel),
        options.maxLevel
      );
    }

    const boxes = this._boxes;
    const frustum = view.frustum;
    if (frustum) {
      transformBoxes(patches.boxes, world, options.grow, boxes);
    }
    counts.fill(0);
    const edges = patches.edges;
    for (let patch = 0; patch < levels.length; patch++) {
      if (frustum && frustum.classifyBounds(boxes, patch * 6) === 'outside') {
        levels[patch] = -1;
        continue;
      }
      const e = patch * 4;
      const level = Math.max(
        edgeLevels[edges[e]],
        edgeLevels[edges[e + 1]],
        edgeLevels[edges[e + 2]],
        edgeLevels[edges[e + 3]]
      );
      levels[patch] = level;
      counts[level]++;
    }
    return this;
  }
}

// Points (x, y, z, x, y, z…) through a column-major matrix.
function transformPoints(
  points: Float64Array,
  m: Matrix4,
  out: Float64Array
): void {
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i];
    const y = points[i + 1];
    const z = points[i + 2];
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
}

// Boxes (min, max) through a matrix, then grown on every side.
function transformBoxes(
  boxes: Float64Array,
  m: Matrix4,
  grow: number,
  out: Float64Array
): void {
  for (let i = 0; i < boxes.length; i += 6) {
    for (let axis = 0; axis < 3; axis++) {
      let center = m[12 + axis];
      let extent = grow;
      for (let k = 0; k < 3; k++) {
        const c = (boxes[i + k] + boxes[i + 3 + k]) / 2;
        const e = (boxes[i + 3 + k] - boxes[i + k]) / 2;
        const factor = m[k * 4 + axis];
        center += factor * c;
        extent += Math.abs(factor) * e;
      }
      out[i + axis] = center - extent;
      out[i + 3 + axis] = center + extent;
    }
  }
}
