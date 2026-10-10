import { dot, ReadonlyVec3, sub, vec3 } from '../math';
import type { Ray } from './Ray';

const offset = vec3();

/**
 * The distance along a ray to a sphere, 0 when the ray starts inside,
 * undefined when it misses.
 */
export function raycastSphere(
  ray: Ray,
  center: ReadonlyVec3,
  radius: number
): number | undefined {
  // |o + t d - c|² = r², with d of unit length.
  sub(offset, ray.origin, center);
  const b = dot(offset, ray.direction);
  const c = dot(offset, offset) - radius * radius;
  if (c <= 0) {
    return 0;
  }
  const discriminant = b * b - c;
  if (b > 0 || discriminant < 0) {
    return undefined;
  }
  return -b - Math.sqrt(discriminant);
}
