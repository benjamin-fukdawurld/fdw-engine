import type { Matrix4, ReadonlyVec3, Vec3 } from '../math';
import type { Aabb } from './Aabb';
import type { Ray } from './Ray';

/**
 * A volume of space: one of the engine (box, sphere, capsule, frustum…), or
 * one defined by the application. The spatial indices store its bounds; the
 * intersection tests use its kind for the fast tests, and its support
 * function for any convex volume.
 */
export interface Volume {
  /**
   * The type of the volume: `'aabb'`, `'sphere'`… for the volumes of the
   * engine. The fast intersection tests are registered by pairs of kinds.
   */
  readonly kind: string;
  /** A box containing the volume, written into `out` when given. */
  bounds(out?: Aabb): Aabb;
  /**
   * The smallest volume of the same kind containing this one transformed by
   * a matrix: exact for translations, rotations and uniform scales when the
   * kind allows it, larger otherwise (a sphere under a non-uniform scale).
   */
  transform(matrix: Matrix4): Volume;
  containsPoint(point: ReadonlyVec3): boolean;
  /**
   * The distance along the ray to the volume (0 when the ray starts inside),
   * or undefined when the ray misses it.
   */
  raycast(ray: Ray): number | undefined;
}

/**
 * A convex volume. Its support function is enough to test its intersection
 * with any other convex volume (GJK), including those of the application.
 */
export interface ConvexVolume extends Volume {
  /** The point of the volume farthest in a direction, written into `out`. */
  support(direction: ReadonlyVec3, out: Vec3): Vec3;
}

export const isConvex = (volume: Volume): volume is ConvexVolume =>
  typeof (volume as Partial<ConvexVolume>).support === 'function';
