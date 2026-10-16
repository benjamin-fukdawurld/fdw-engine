import {
  copy,
  dot,
  length,
  Matrix4,
  maxScale,
  ReadonlyVec3,
  scaleAndAdd,
  set,
  sub,
  transformPoint,
  Vec3,
  vec3,
} from '../math';
import { Aabb } from './Aabb';
import type { Ray } from './Ray';
import { raycastSphere } from './raycastSphere';
import type { ConvexVolume } from './Volume';

const offset = vec3();

export class Sphere implements ConvexVolume {
  readonly kind = 'sphere';
  readonly center: Vec3;
  radius: number;

  constructor(center: ReadonlyVec3 = [0, 0, 0], radius = 0) {
    this.center = copy(vec3(), center);
    this.radius = radius;
  }

  bounds(out: Aabb = new Aabb()): Aabb {
    const [x, y, z] = this.center;
    const r = this.radius;
    set(out.min, x - r, y - r, z - r);
    set(out.max, x + r, y + r, z + r);
    return out;
  }

  transform(matrix: Matrix4): Sphere {
    return new Sphere(
      transformPoint(vec3(), matrix, this.center),
      this.radius * maxScale(matrix),
    );
  }

  containsPoint(point: ReadonlyVec3): boolean {
    sub(offset, point, this.center);
    return dot(offset, offset) <= this.radius * this.radius;
  }

  raycast(ray: Ray): number | undefined {
    return raycastSphere(ray, this.center, this.radius);
  }

  support(direction: ReadonlyVec3, out: Vec3): Vec3 {
    const l = length(direction);
    return l > 0
      ? scaleAndAdd(out, this.center, direction, this.radius / l)
      : copy(out, this.center);
  }

  intersectsSphere(sphere: Sphere): boolean {
    sub(offset, sphere.center, this.center);
    const r = this.radius + sphere.radius;
    return dot(offset, offset) <= r * r;
  }

  intersectsAabb(box: Aabb): boolean {
    // The distance from the center to the closest point of the box.
    let distance = 0;
    for (let axis = 0; axis < 3; axis++) {
      const c = this.center[axis];
      const d =
        c < box.min[axis]
          ? box.min[axis] - c
          : c > box.max[axis]
            ? c - box.max[axis]
            : 0;
      distance += d * d;
    }
    return distance <= this.radius * this.radius;
  }
}
