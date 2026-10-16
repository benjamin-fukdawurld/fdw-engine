import { copy, Matrix4, ReadonlyVec3, set, Vec3, vec3 } from '../math';
import type { Ray } from './Ray';
import type { ConvexVolume } from './Volume';

/** A box aligned on the axes: what the spatial indices store. */
export class Aabb implements ConvexVolume {
  readonly kind = 'aabb';
  readonly min: Vec3;
  readonly max: Vec3;

  constructor(min: ReadonlyVec3 = [0, 0, 0], max: ReadonlyVec3 = [0, 0, 0]) {
    this.min = copy(vec3(), min);
    this.max = copy(vec3(), max);
  }

  /** A box containing nothing: the starting point of a union. */
  static empty(): Aabb {
    return new Aabb().makeEmpty();
  }

  /** The box of a set of points. */
  static fromPoints(points: Iterable<ReadonlyVec3>): Aabb {
    const box = Aabb.empty();
    for (const point of points) {
      box.expandByPoint(point);
    }
    return box;
  }

  makeEmpty(): this {
    set(this.min, Infinity, Infinity, Infinity);
    set(this.max, -Infinity, -Infinity, -Infinity);
    return this;
  }

  isEmpty(): boolean {
    return (
      this.min[0] > this.max[0] ||
      this.min[1] > this.max[1] ||
      this.min[2] > this.max[2]
    );
  }

  setFrom(min: ReadonlyVec3, max: ReadonlyVec3): this {
    copy(this.min, min);
    copy(this.max, max);
    return this;
  }

  copyFrom(box: Aabb): this {
    return this.setFrom(box.min, box.max);
  }

  expandByPoint(point: ReadonlyVec3): this {
    for (let axis = 0; axis < 3; axis++) {
      this.min[axis] = Math.min(this.min[axis], point[axis]);
      this.max[axis] = Math.max(this.max[axis], point[axis]);
    }
    return this;
  }

  /** Grows the box to contain another one. */
  union(box: Aabb): this {
    for (let axis = 0; axis < 3; axis++) {
      this.min[axis] = Math.min(this.min[axis], box.min[axis]);
      this.max[axis] = Math.max(this.max[axis], box.max[axis]);
    }
    return this;
  }

  center(out: Vec3 = vec3()): Vec3 {
    return set(
      out,
      (this.min[0] + this.max[0]) / 2,
      (this.min[1] + this.max[1]) / 2,
      (this.min[2] + this.max[2]) / 2,
    );
  }

  /** Half the size of the box along each axis. */
  halfExtents(out: Vec3 = vec3()): Vec3 {
    return set(
      out,
      (this.max[0] - this.min[0]) / 2,
      (this.max[1] - this.min[1]) / 2,
      (this.max[2] - this.min[2]) / 2,
    );
  }

  intersectsAabb(box: Aabb): boolean {
    return (
      this.min[0] <= box.max[0] &&
      this.max[0] >= box.min[0] &&
      this.min[1] <= box.max[1] &&
      this.max[1] >= box.min[1] &&
      this.min[2] <= box.max[2] &&
      this.max[2] >= box.min[2]
    );
  }

  containsAabb(box: Aabb): boolean {
    return (
      this.min[0] <= box.min[0] &&
      this.max[0] >= box.max[0] &&
      this.min[1] <= box.min[1] &&
      this.max[1] >= box.max[1] &&
      this.min[2] <= box.min[2] &&
      this.max[2] >= box.max[2]
    );
  }

  bounds(out: Aabb = new Aabb()): Aabb {
    return out.copyFrom(this);
  }

  transform(matrix: Matrix4): Aabb {
    return transformAabb(this, matrix, new Aabb());
  }

  containsPoint(point: ReadonlyVec3): boolean {
    return (
      point[0] >= this.min[0] &&
      point[0] <= this.max[0] &&
      point[1] >= this.min[1] &&
      point[1] <= this.max[1] &&
      point[2] >= this.min[2] &&
      point[2] <= this.max[2]
    );
  }

  raycast(ray: Ray): number | undefined {
    return raycastBox(ray.origin, ray.direction, this.min, this.max);
  }

  support(direction: ReadonlyVec3, out: Vec3): Vec3 {
    return set(
      out,
      direction[0] >= 0 ? this.max[0] : this.min[0],
      direction[1] >= 0 ? this.max[1] : this.min[1],
      direction[2] >= 0 ? this.max[2] : this.min[2],
    );
  }
}

/**
 * The box containing a box transformed by a matrix, written into `out`
 * (Arvo's method: no transformation of the eight corners). An empty box
 * stays empty.
 */
export function transformAabb(box: Aabb, m: Matrix4, out: Aabb): Aabb {
  if (box.isEmpty()) {
    return out.makeEmpty();
  }
  const { min, max } = box;
  // The translation, then for each axis the smallest and largest products.
  let x0 = m[12];
  let y0 = m[13];
  let z0 = m[14];
  let x1 = x0;
  let y1 = y0;
  let z1 = z0;
  for (let column = 0; column < 3; column++) {
    const low = min[column];
    const high = max[column];
    const mx = m[column * 4];
    const my = m[column * 4 + 1];
    const mz = m[column * 4 + 2];
    x0 += Math.min(mx * low, mx * high);
    x1 += Math.max(mx * low, mx * high);
    y0 += Math.min(my * low, my * high);
    y1 += Math.max(my * low, my * high);
    z0 += Math.min(mz * low, mz * high);
    z1 += Math.max(mz * low, mz * high);
  }
  set(out.min, x0, y0, z0);
  set(out.max, x1, y1, z1);
  return out;
}

/**
 * The distance along a ray to a box (the slab method), 0 when the ray
 * starts inside, undefined when it misses.
 */
export function raycastBox(
  origin: ReadonlyVec3,
  direction: ReadonlyVec3,
  min: ReadonlyVec3,
  max: ReadonlyVec3,
): number | undefined {
  let near = 0;
  let far = Infinity;
  for (let axis = 0; axis < 3; axis++) {
    const d = direction[axis];
    const o = origin[axis];
    if (d === 0) {
      if (o < min[axis] || o > max[axis]) {
        return undefined;
      }
      continue;
    }
    let t0 = (min[axis] - o) / d;
    let t1 = (max[axis] - o) / d;
    if (t0 > t1) {
      [t0, t1] = [t1, t0];
    }
    near = Math.max(near, t0);
    far = Math.min(far, t1);
    if (near > far) {
      return undefined;
    }
  }
  return near;
}
