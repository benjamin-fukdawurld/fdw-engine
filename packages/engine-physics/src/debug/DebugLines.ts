import type { IVec3 } from '@fdw/engine-backend';
import type { PhysicsWorld } from '../api';
import { PoseSize } from '../api';
import { rotate } from '../math';
import type { Shape } from '../shapes';

/** An RGB color, from 0 to 1. */
export type DebugColor = readonly [number, number, number];

/** The colors of the debug view. */
export interface DebugColors {
  readonly static: DebugColor;
  readonly dynamic: DebugColor;
  readonly sleeping: DebugColor;
  readonly kinematic: DebugColor;
  readonly sensor: DebugColor;
  readonly contact: DebugColor;
  readonly joint: DebugColor;
  readonly ray: DebugColor;
  readonly hit: DebugColor;
}

export const defaultDebugColors: DebugColors = {
  static: [0.55, 0.6, 0.65],
  dynamic: [1, 0.55, 0.1],
  sleeping: [0.3, 0.55, 1],
  kinematic: [0.75, 0.35, 1],
  sensor: [1, 0.9, 0.2],
  contact: [1, 0.15, 0.15],
  joint: [0.2, 1, 0.5],
  ray: [1, 1, 1],
  hit: [1, 0.15, 0.15],
};

/** What the debug view draws. */
export interface DebugOptions {
  /** The shapes of the colliders. Default true. */
  readonly shapes?: boolean;
  /** The contact points, and their normals. Default true. */
  readonly contacts?: boolean;
  /** The anchors of the joints, joined. Default true. */
  readonly joints?: boolean;
  readonly colors?: Partial<DebugColors>;
}

// The segments of a circle, and of each half of a capsule.
const segments = 16;

/**
 * Line segments: two points each, a position and a color per point. The
 * arrays grow as needed; `count` is the number of points.
 */
export class DebugLines {
  positions = new Float32Array(3 * 1024);
  colors = new Float32Array(4 * 1024);
  count = 0;

  clear(): void {
    this.count = 0;
  }

  line(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    color: DebugColor,
  ): void {
    if (this.count + 2 > this.positions.length / 3) {
      this.grow();
    }
    const p = this.positions;
    const c = this.colors;
    let i = this.count * 3;
    p[i] = ax;
    p[i + 1] = ay;
    p[i + 2] = az;
    p[i + 3] = bx;
    p[i + 4] = by;
    p[i + 5] = bz;
    i = this.count * 4;
    for (let k = 0; k < 2; k++, i += 4) {
      c[i] = color[0];
      c[i + 1] = color[1];
      c[i + 2] = color[2];
      c[i + 3] = 1;
    }
    this.count += 2;
  }

  /** A small cross at a point. */
  cross(point: IVec3, size: number, color: DebugColor): void {
    const { x, y, z } = point;
    this.line(x - size, y, z, x + size, y, z, color);
    this.line(x, y - size, z, x, y + size, z, color);
    this.line(x, y, z - size, x, y, z + size, color);
  }

  private grow(): void {
    const positions = new Float32Array(this.positions.length * 2);
    positions.set(this.positions);
    this.positions = positions;
    const colors = new Float32Array(this.colors.length * 2);
    colors.set(this.colors);
    this.colors = colors;
  }
}

/**
 * Draws a world in lines: the shapes of its colliders (colored by the
 * state of their body), its contacts and its joints. Written against the
 * abstract API: any engine gets it.
 */
export function drawWorld(
  world: PhysicsWorld,
  lines: DebugLines,
  options: DebugOptions = {},
): void {
  const colors = { ...defaultDebugColors, ...options.colors };
  const pose = new Float32Array(PoseSize);
  if (options.shapes ?? true) {
    for (const body of world.bodies) {
      const color =
        body.type === 'static'
          ? colors.static
          : body.type === 'kinematic'
            ? colors.kinematic
            : body.sleeping
              ? colors.sleeping
              : colors.dynamic;
      for (const collider of body.colliders) {
        collider.readPose(pose);
        drawShape(
          lines,
          collider.shape,
          pose,
          collider.sensor ? colors.sensor : color,
        );
      }
    }
  }
  if (options.contacts ?? true) {
    world.contacts(({ point, normal }) => {
      lines.cross(point, 0.05, colors.contact);
      lines.line(
        point.x,
        point.y,
        point.z,
        point.x + normal.x * 0.3,
        point.y + normal.y * 0.3,
        point.z + normal.z * 0.3,
        colors.contact,
      );
    });
  }
  if (options.joints ?? true) {
    const anchors = new Float32Array(6);
    for (const joint of world.joints) {
      joint.readAnchors(anchors);
      lines.cross(
        { x: anchors[0], y: anchors[1], z: anchors[2] },
        0.08,
        colors.joint,
      );
      lines.line(
        anchors[0],
        anchors[1],
        anchors[2],
        anchors[3],
        anchors[4],
        anchors[5],
        colors.joint,
      );
    }
  }
}

/** Draws a shape at a pose (PoseSize floats). */
export function drawShape(
  lines: DebugLines,
  shape: Shape,
  pose: ArrayLike<number>,
  color: DebugColor,
): void {
  const a = [0, 0, 0];
  const b = [0, 0, 0];
  // A segment in the space of the shape.
  const segment = (
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
  ) => {
    rotate(pose, 3, ax, ay, az, a);
    rotate(pose, 3, bx, by, bz, b);
    lines.line(
      a[0] + pose[0],
      a[1] + pose[1],
      a[2] + pose[2],
      b[0] + pose[0],
      b[1] + pose[1],
      b[2] + pose[2],
      color,
    );
  };
  // An arc of radius r around (0, y, 0) in a plane: 'xz' (horizontal),
  // 'xy' or 'zy' (vertical, from the angle `from` to `to`).
  const arc = (
    plane: 'xz' | 'xy' | 'zy',
    y: number,
    r: number,
    from = 0,
    to = 2 * Math.PI,
  ) => {
    const point = (angle: number): [number, number, number] => {
      const u = Math.cos(angle) * r;
      const v = Math.sin(angle) * r;
      return plane === 'xz'
        ? [u, y, v]
        : plane === 'xy'
          ? [u, y + v, 0]
          : [0, y + v, u];
    };
    let previous = point(from);
    for (let i = 1; i <= segments; i++) {
      const next = point(from + ((to - from) * i) / segments);
      segment(...previous, ...next);
      previous = next;
    }
  };
  const triangles = (vertices: Float32Array, indices: Uint32Array) => {
    const v = vertices;
    for (let i = 0; i + 2 < indices.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const p = indices[i + k] * 3;
        const q = indices[i + ((k + 1) % 3)] * 3;
        segment(v[p], v[p + 1], v[p + 2], v[q], v[q + 1], v[q + 2]);
      }
    }
  };

  switch (shape.type) {
    case 'sphere':
      arc('xz', 0, shape.radius);
      arc('xy', 0, shape.radius);
      arc('zy', 0, shape.radius);
      break;
    case 'box': {
      const { x, y, z } = shape.halfExtents;
      for (const [sy, sz] of [
        [-1, -1],
        [-1, 1],
        [1, -1],
        [1, 1],
      ]) {
        segment(-x, sy * y, sz * z, x, sy * y, sz * z);
        segment(sy * x, -y, sz * z, sy * x, y, sz * z);
        segment(sy * x, sz * y, -z, sy * x, sz * y, z);
      }
      break;
    }
    case 'capsule':
    case 'cylinder': {
      const { halfHeight: h, radius: r } = shape;
      arc('xz', -h, r);
      arc('xz', h, r);
      for (const [x, z] of [
        [r, 0],
        [-r, 0],
        [0, r],
        [0, -r],
      ]) {
        segment(x, -h, z, x, h, z);
      }
      if (shape.type === 'capsule') {
        arc('xy', h, r, 0, Math.PI);
        arc('zy', h, r, 0, Math.PI);
        arc('xy', -h, r, Math.PI, 2 * Math.PI);
        arc('zy', -h, r, Math.PI, 2 * Math.PI);
      }
      break;
    }
    case 'convex':
      if (shape.indices) {
        triangles(shape.points, shape.indices);
      } else {
        // The hull is the engine's: its points.
        const p = shape.points;
        for (let i = 0; i + 2 < p.length; i += 3) {
          const s = 0.03;
          segment(p[i] - s, p[i + 1], p[i + 2], p[i] + s, p[i + 1], p[i + 2]);
          segment(p[i], p[i + 1] - s, p[i + 2], p[i], p[i + 1] + s, p[i + 2]);
          segment(p[i], p[i + 1], p[i + 2] - s, p[i], p[i + 1], p[i + 2] + s);
        }
      }
      break;
    case 'mesh':
      triangles(shape.vertices, shape.indices);
      break;
    case 'heightfield': {
      const { rows, columns, heights, size } = shape;
      const x = (column: number) => (column / (columns - 1) - 0.5) * size.x;
      const z = (row: number) => (row / (rows - 1) - 0.5) * size.z;
      const y = (row: number, column: number) =>
        heights[row * columns + column] * size.y;
      for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
          if (column + 1 < columns) {
            segment(
              x(column),
              y(row, column),
              z(row),
              x(column + 1),
              y(row, column + 1),
              z(row),
            );
          }
          if (row + 1 < rows) {
            segment(
              x(column),
              y(row, column),
              z(row),
              x(column),
              y(row + 1, column),
              z(row + 1),
            );
          }
        }
      }
      break;
    }
  }
}
