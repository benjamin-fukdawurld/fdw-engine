import {
  copy,
  dot,
  length,
  Matrix4,
  maxScale,
  ReadonlyVec3,
  scaleAndAdd,
  sub,
  transformPoint,
  Vec3,
  vec3,
} from '../math';
import { Aabb } from './Aabb';
import type { Ray } from './Ray';
import { raycastSphere } from './raycastSphere';
import { closestOnSegment, segmentDistanceSquared } from './segments';
import type { ConvexVolume } from './Volume';

const closest = vec3();
const offset = vec3();
const axis = vec3();
const fromStart = vec3();

/**
 * The points within a radius of a segment: a cylinder with rounded ends.
 * The usual volume of characters.
 */
export class Capsule implements ConvexVolume {
  readonly kind = 'capsule';
  readonly start: Vec3;
  readonly end: Vec3;
  radius: number;

  constructor(
    start: ReadonlyVec3 = [0, 0, 0],
    end: ReadonlyVec3 = [0, 0, 0],
    radius = 0,
  ) {
    this.start = copy(vec3(), start);
    this.end = copy(vec3(), end);
    this.radius = radius;
  }

  bounds(out: Aabb = new Aabb()): Aabb {
    for (let i = 0; i < 3; i++) {
      out.min[i] = Math.min(this.start[i], this.end[i]) - this.radius;
      out.max[i] = Math.max(this.start[i], this.end[i]) + this.radius;
    }
    return out;
  }

  transform(matrix: Matrix4): Capsule {
    return new Capsule(
      transformPoint(vec3(), matrix, this.start),
      transformPoint(vec3(), matrix, this.end),
      this.radius * maxScale(matrix),
    );
  }

  containsPoint(point: ReadonlyVec3): boolean {
    closestOnSegment(closest, point, this.start, this.end);
    sub(offset, point, closest);
    return dot(offset, offset) <= this.radius * this.radius;
  }

  raycast(ray: Ray): number | undefined {
    if (this.containsPoint(ray.origin)) {
      return 0;
    }
    // The nearest hit among the side of the cylinder and the two spheres
    // of the ends.
    let nearest = raycastSphere(ray, this.start, this.radius);
    const atEnd = raycastSphere(ray, this.end, this.radius);
    if (atEnd !== undefined && (nearest === undefined || atEnd < nearest)) {
      nearest = atEnd;
    }
    sub(axis, this.end, this.start);
    sub(fromStart, ray.origin, this.start);
    const axisLength2 = dot(axis, axis);
    const axisDirection = dot(axis, ray.direction);
    const axisOrigin = dot(axis, fromStart);
    const a = axisLength2 - axisDirection * axisDirection;
    if (a > 1e-12) {
      const b =
        axisLength2 * dot(ray.direction, fromStart) -
        axisOrigin * axisDirection;
      const c =
        axisLength2 * dot(fromStart, fromStart) -
        axisOrigin * axisOrigin -
        this.radius * this.radius * axisLength2;
      const discriminant = b * b - a * c;
      if (discriminant >= 0) {
        const t = (-b - Math.sqrt(discriminant)) / a;
        // Along the axis, between the ends.
        const y = axisOrigin + t * axisDirection;
        if (
          t >= 0 &&
          y > 0 &&
          y < axisLength2 &&
          (nearest === undefined || t < nearest)
        ) {
          nearest = t;
        }
      }
    }
    return nearest;
  }

  support(direction: ReadonlyVec3, out: Vec3): Vec3 {
    const end =
      dot(direction, this.end) > dot(direction, this.start)
        ? this.end
        : this.start;
    const l = length(direction);
    return l > 0
      ? scaleAndAdd(out, end, direction, this.radius / l)
      : copy(out, end);
  }

  intersectsCapsule(capsule: Capsule): boolean {
    const r = this.radius + capsule.radius;
    return (
      segmentDistanceSquared(
        this.start,
        this.end,
        capsule.start,
        capsule.end,
      ) <=
      r * r
    );
  }

  intersectsSphere(center: ReadonlyVec3, radius: number): boolean {
    closestOnSegment(closest, center, this.start, this.end);
    sub(offset, center, closest);
    const r = this.radius + radius;
    return dot(offset, offset) <= r * r;
  }
}
