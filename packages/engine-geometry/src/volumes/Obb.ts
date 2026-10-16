import {
  copy,
  cross,
  dot,
  length,
  Matrix4,
  normalize,
  ReadonlyVec3,
  scale,
  scaleAndAdd,
  set,
  sub,
  transformDirection,
  transformPoint,
  Vec3,
  vec3,
} from '../math';
import { Aabb, raycastBox } from './Aabb';
import type { Ray } from './Ray';
import type { ConvexVolume } from './Volume';

const offset = vec3();
const localOrigin = vec3();
const localDirection = vec3();

/** A box oriented by three orthonormal axes: the tight bounds of a turned object. */
export class Obb implements ConvexVolume {
  readonly kind = 'obb';
  readonly center: Vec3;
  readonly halfExtents: Vec3;
  readonly axes: readonly [Vec3, Vec3, Vec3];

  /** Without axes, the box is aligned on the world axes. */
  constructor(
    center: ReadonlyVec3 = [0, 0, 0],
    halfExtents: ReadonlyVec3 = [0, 0, 0],
    axes: readonly [ReadonlyVec3, ReadonlyVec3, ReadonlyVec3] = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
  ) {
    this.center = copy(vec3(), center);
    this.halfExtents = copy(vec3(), halfExtents);
    this.axes = [
      normalize(vec3(), axes[0]),
      normalize(vec3(), axes[1]),
      normalize(vec3(), axes[2]),
    ];
  }

  bounds(out: Aabb = new Aabb()): Aabb {
    const [h0, h1, h2] = this.halfExtents;
    const [a0, a1, a2] = this.axes;
    for (let axis = 0; axis < 3; axis++) {
      const extent =
        Math.abs(a0[axis]) * h0 +
        Math.abs(a1[axis]) * h1 +
        Math.abs(a2[axis]) * h2;
      out.min[axis] = this.center[axis] - extent;
      out.max[axis] = this.center[axis] + extent;
    }
    return out;
  }

  /**
   * Exact for rotations, translations and scales along the axes of the box;
   * a non-uniform scale across them shears the box, which is then bounded
   * by a larger one.
   */
  transform(matrix: Matrix4): Obb {
    // The edges of the box, transformed, then made orthonormal.
    const edges = this.axes.map((axis, i) =>
      transformDirection(
        vec3(),
        matrix,
        scale(vec3(), axis, this.halfExtents[i]),
      ),
    );
    const e0 = normalize(vec3(), edges[0]);
    const e1 = normalize(
      vec3(),
      scaleAndAdd(vec3(), edges[1], e0, -dot(edges[1], e0)),
    );
    if (length(e0) === 0 || length(e1) === 0) {
      // A flattened box: its bounds on the world axes.
      return Obb.fromAabb(this.bounds().transform(matrix));
    }
    const e2 = cross(vec3(), e0, e1);
    const axes = [e0, e1, e2] as const;
    const halfExtents = axes.map((e) =>
      edges.reduce((sum, edge) => sum + Math.abs(dot(edge, e)), 0),
    ) as Vec3;
    return new Obb(
      transformPoint(vec3(), matrix, this.center),
      halfExtents,
      axes,
    );
  }

  static fromAabb(box: Aabb): Obb {
    return new Obb(box.center(), box.halfExtents());
  }

  containsPoint(point: ReadonlyVec3): boolean {
    sub(offset, point, this.center);
    return this.axes.every(
      (axis, i) => Math.abs(dot(offset, axis)) <= this.halfExtents[i],
    );
  }

  raycast(ray: Ray): number | undefined {
    // In the space of the box: the axes are orthonormal, distances are kept.
    sub(offset, ray.origin, this.center);
    const [a0, a1, a2] = this.axes;
    set(localOrigin, dot(offset, a0), dot(offset, a1), dot(offset, a2));
    set(
      localDirection,
      dot(ray.direction, a0),
      dot(ray.direction, a1),
      dot(ray.direction, a2),
    );
    const [h0, h1, h2] = this.halfExtents;
    return raycastBox(
      localOrigin,
      localDirection,
      [-h0, -h1, -h2],
      [h0, h1, h2],
    );
  }

  support(direction: ReadonlyVec3, out: Vec3): Vec3 {
    copy(out, this.center);
    this.axes.forEach((axis, i) => {
      const sign = dot(direction, axis) >= 0 ? 1 : -1;
      scaleAndAdd(out, out, axis, sign * this.halfExtents[i]);
    });
    return out;
  }
}
