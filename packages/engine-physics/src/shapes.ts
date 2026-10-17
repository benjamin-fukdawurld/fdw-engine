import type { IVec3 } from '@fdw/engine-backend';

// The collision shapes: plain data, in the space of their collider, which
// any physics engine translates to its own. Not scaled by the nodes: a
// shape has the size it says.

/** A sphere around the origin. */
export interface SphereShape {
  readonly type: 'sphere';
  readonly radius: number;
}

/** A box around the origin: half its size along each axis. */
export interface BoxShape {
  readonly type: 'box';
  readonly halfExtents: IVec3;
}

/**
 * A capsule along the y axis: a cylinder of `2 × halfHeight` closed by two
 * half spheres; `2 × (halfHeight + radius)` tall in all.
 */
export interface CapsuleShape {
  readonly type: 'capsule';
  readonly halfHeight: number;
  readonly radius: number;
}

/** A cylinder along the y axis, `2 × halfHeight` tall. */
export interface CylinderShape {
  readonly type: 'cylinder';
  readonly halfHeight: number;
  readonly radius: number;
}

/**
 * The convex hull of points (x, y, z each). With `indices`, the points and
 * triangles are the hull already, kept as they are (and drawn by the debug
 * view); without, the engine computes the hull.
 */
export interface ConvexShape {
  readonly type: 'convex';
  readonly points: Float32Array;
  readonly indices?: Uint32Array;
}

/**
 * A triangle mesh: hollow, for the static bodies (a level, a terrain). Its
 * triangles counter-clockwise seen from outside.
 */
export interface MeshShape {
  readonly type: 'mesh';
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
}

/**
 * A grid of heights, centered on the origin: `rows × columns` samples,
 * row after row (`heights[row * columns + column]`), the rows along z and
 * the columns along x, from -size / 2 to size / 2. The heights are scaled
 * by `size.y`.
 */
export interface HeightfieldShape {
  readonly type: 'heightfield';
  readonly rows: number;
  readonly columns: number;
  readonly heights: Float32Array;
  readonly size: IVec3;
}

export type Shape =
  | SphereShape
  | BoxShape
  | CapsuleShape
  | CylinderShape
  | ConvexShape
  | MeshShape
  | HeightfieldShape;

export type ShapeType = Shape['type'];

/** Short ways to write the shapes. */
export const Shapes = {
  sphere: (radius: number): SphereShape => ({ type: 'sphere', radius }),
  /** A box of half extents x, y, z (y and z default to x: a cube). */
  box: (x: number, y = x, z = x): BoxShape => ({
    type: 'box',
    halfExtents: { x, y, z },
  }),
  capsule: (halfHeight: number, radius: number): CapsuleShape => ({
    type: 'capsule',
    halfHeight,
    radius,
  }),
  cylinder: (halfHeight: number, radius: number): CylinderShape => ({
    type: 'cylinder',
    halfHeight,
    radius,
  }),
  convex: (
    points: ArrayLike<number>,
    indices?: ArrayLike<number>,
  ): ConvexShape => ({
    type: 'convex',
    points: Float32Array.from(points),
    ...(indices ? { indices: Uint32Array.from(indices) } : {}),
  }),
  mesh: (
    vertices: ArrayLike<number>,
    indices: ArrayLike<number>,
  ): MeshShape => ({
    type: 'mesh',
    vertices: Float32Array.from(vertices),
    indices: Uint32Array.from(indices),
  }),
  heightfield: (
    rows: number,
    columns: number,
    heights: ArrayLike<number>,
    size: IVec3,
  ): HeightfieldShape => {
    if (heights.length !== rows * columns) {
      throw new Error(
        `A heightfield of ${rows} × ${columns} needs ${rows * columns} heights, not ${heights.length}`,
      );
    }
    if (rows < 2 || columns < 2) {
      throw new Error('A heightfield needs 2 rows and 2 columns at least');
    }
    return {
      type: 'heightfield',
      rows,
      columns,
      heights: Float32Array.from(heights),
      size,
    };
  },
} as const;
