import { Mesh } from '@fdw/engine-core';

/** The rings of an ocean grid around the camera (see {@link clipmapGrid}). */
export interface ClipmapOptions {
  /** The side of the cells of the finest ring, in meters (0.5). */
  readonly cell?: number;
  /** The rings, each with cells twice as large as the one inside it (7). */
  readonly levels?: number;
  /** The cells from the center to the edge of the finest ring: even (32). */
  readonly size?: number;
  /** Where the flat skirt around the rings ends, in meters (20 km). */
  readonly horizon?: number;
}

/** A grid of rings: its mesh, and how to follow the camera with it. */
export interface ClipmapGrid {
  readonly mesh: Mesh;
  /** The cells of the coarsest ring: the grid moves by steps of it. */
  readonly step: number;
  /** The half side of the rings; the skirt goes on to the horizon. */
  readonly extent: number;
  readonly horizon: number;
  readonly levels: number;
  readonly cell: number;
  readonly size: number;
}

/**
 * A flat grid around the origin, finer in the middle: squares of
 * `size` × 2 cells, each ring around the previous one with cells twice as
 * large (a geometry clipmap, Losasso and Hoppe 2004), then a flat skirt to
 * the horizon. Drawn around the camera and moved by steps of the coarsest
 * cell, its vertices stay on the same points of the world: the waves do
 * not swim under them.
 *
 * Where a ring meets a coarser one, its vertices between two of the coarse
 * ring are moved onto one of them: the triangles there fold, but the edge
 * has the points of the coarse one, without cracks once displaced.
 */
export function clipmapGrid(options: ClipmapOptions = {}): ClipmapGrid {
  const cell = options.cell ?? 0.5;
  const levels = options.levels ?? 7;
  const size = options.size ?? 32;
  if (size < 4 || size % 2 !== 0) {
    throw new Error(`The rings need an even size, from 4 on: ${size}`);
  }
  if (levels < 1) {
    throw new Error('The grid needs one ring at least');
  }
  const extent = size * cell * 2 ** (levels - 1);
  const horizon = Math.max(options.horizon ?? 20_000, extent * 2);

  // Vertices by position, in units of the finest cell (exact integers);
  // shared between the rings.
  const positions: number[] = [];
  const ids = new Map<string, number>();
  const vertex = (x: number, z: number) => {
    const key = `${x},${z}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = positions.length / 3;
      ids.set(key, id);
      positions.push(x * cell, 0, z * cell);
    }
    return id;
  };
  const indices: number[] = [];
  // A quad, counterclockwise seen from above (+y): its triangles face up.
  const quad = (a: number, b: number, c: number, d: number) => {
    for (const [p, q, r] of [
      [a, d, c],
      [a, c, b],
    ]) {
      if (p !== q && q !== r && p !== r) {
        indices.push(p, q, r);
      }
    }
  };

  for (let level = 0; level < levels; level++) {
    // In units of the finest cell.
    const step = 2 ** level;
    const half = size * step;
    const inner = level === 0 ? 0 : half / 2;
    const outer = level < levels - 1;
    // A point of the ring, moved onto the coarse grid on its outer edge.
    const point = (x: number, z: number) => {
      if (outer) {
        const coarse = step * 2;
        const onX = Math.abs(x) === half;
        const onZ = Math.abs(z) === half;
        if (onZ && x % coarse !== 0) {
          x -= step;
        }
        if (onX && z % coarse !== 0) {
          z -= step;
        }
      }
      return vertex(x, z);
    };
    for (let j = -half; j < half; j += step) {
      for (let i = -half; i < half; i += step) {
        // Inside the finer ring.
        if (
          level > 0 &&
          i >= -inner &&
          i + step <= inner &&
          j >= -inner &&
          j + step <= inner
        ) {
          continue;
        }
        quad(
          point(i, j),
          point(i + step, j),
          point(i + step, j + step),
          point(i, j + step),
        );
      }
    }
  }

  // The skirt: squares of 4 × 4 cells less their 2 × 2 middle, each twice
  // as large as the last, to the horizon. The waves have faded out there.
  let half = extent / cell;
  const end = horizon / cell;
  while (half < end) {
    const step = half / 2;
    for (let j = -2 * half; j < 2 * half; j += step) {
      for (let i = -2 * half; i < 2 * half; i += step) {
        if (i >= -half && i + step <= half && j >= -half && j + step <= half) {
          continue;
        }
        quad(
          vertex(i, j),
          vertex(i + step, j),
          vertex(i + step, j + step),
          vertex(i, j + step),
        );
      }
    }
    half *= 2;
  }

  const count = positions.length / 3;
  const wide = count > 65535;
  const mesh = new Mesh({
    label: 'ocean grid',
    description: {
      vertexBuffers: [
        {
          stride: 12,
          stepMode: 'vertex',
          attributes: [
            { semantic: 'position', format: 'float32x3', offset: 0 },
          ],
        },
      ],
      vertexCount: count,
      indexBuffer: {
        format: wide ? 'uint32' : 'uint16',
        count: indices.length,
      },
    },
    vertices: [new Float32Array(positions)],
    indices: wide ? new Uint32Array(indices) : new Uint16Array(indices),
  });
  return {
    mesh,
    step: cell * 2 ** (levels - 1),
    extent,
    horizon: half * cell,
    levels,
    cell,
    size,
  };
}
