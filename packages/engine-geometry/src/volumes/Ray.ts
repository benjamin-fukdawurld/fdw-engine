import {
  copy,
  normalize,
  ReadonlyVec3,
  scaleAndAdd,
  Vec3,
  vec3,
} from '../math';

/** A half-line: an origin and a unit direction. */
export class Ray {
  readonly origin: Vec3;
  readonly direction: Vec3;

  /** The direction is normalized. */
  constructor(origin: ReadonlyVec3, direction: ReadonlyVec3) {
    this.origin = copy(vec3(), origin);
    this.direction = normalize(vec3(), direction);
  }

  /** The point at a distance along the ray. */
  at(distance: number, out: Vec3 = vec3()): Vec3 {
    return scaleAndAdd(out, this.origin, this.direction, distance);
  }
}
