import {
  cross,
  dot,
  invert,
  Matrix4,
  ReadonlyVec3,
  scale,
  scaleAndAdd,
  set,
  Vec3,
  vec3,
} from '../math';
import { Aabb } from './Aabb';
import type { Ray } from './Ray';
import type { ConvexVolume } from './Volume';

/** Where a box is relative to a frustum. */
export type Classification = 'outside' | 'intersects' | 'inside';

// The planes, in this order; each one as (nx, ny, nz, d) with n · p + d ≥ 0
// inside and n of unit length.
const Left = 0;
const Right = 1;
const Bottom = 2;
const Top = 3;
const Near = 4;
const Far = 5;

const n1 = vec3();
const n2 = vec3();
const n3 = vec3();
const c23 = vec3();
const c31 = vec3();
const c12 = vec3();

/**
 * The volume seen by a camera: six planes, extracted from a view-projection
 * matrix (Gribb and Hartmann), with the clip space depth from 0 to 1 of the
 * engine.
 */
export class Frustum implements ConvexVolume {
  readonly kind = 'frustum';
  readonly planes = new Float64Array(24);
  private _corners?: Vec3[];

  static fromMatrix(viewProjection: Matrix4): Frustum {
    return new Frustum().setFromMatrix(viewProjection);
  }

  /** Reuses the frustum for another matrix: no allocation per frame. */
  setFromMatrix(m: Matrix4): this {
    // The rows of the matrix.
    const row = (i: number) => [m[i], m[4 + i], m[8 + i], m[12 + i]];
    const [r0, r1, r2, r3] = [row(0), row(1), row(2), row(3)];
    const combine = (plane: number, a: number[], b: number[], sign: number) => {
      for (let i = 0; i < 4; i++) {
        this.planes[plane * 4 + i] = a[i] + sign * b[i];
      }
    };
    combine(Left, r3, r0, 1);
    combine(Right, r3, r0, -1);
    combine(Bottom, r3, r1, 1);
    combine(Top, r3, r1, -1);
    // Depth from 0 to 1: the near plane is z ≥ 0.
    combine(Near, [0, 0, 0, 0], r2, 1);
    combine(Far, r3, r2, -1);
    return this.normalizePlanes();
  }

  /**
   * Sets the six planes directly (left, right, bottom, top, near, far, each
   * as nx, ny, nz, d with n · p + d ≥ 0 inside): a volume that no camera
   * gives, such as the pyramid around the cone of a spot light.
   */
  setPlanes(planes: ArrayLike<number>): this {
    for (let i = 0; i < 24; i++) {
      this.planes[i] = planes[i];
    }
    return this.normalizePlanes();
  }

  private normalizePlanes(): this {
    const p = this.planes;
    for (let i = 0; i < 24; i += 4) {
      const l = Math.hypot(p[i], p[i + 1], p[i + 2]) || 1;
      p[i] /= l;
      p[i + 1] /= l;
      p[i + 2] /= l;
      p[i + 3] /= l;
    }
    this._corners = undefined;
    return this;
  }

  /** The signed distance of a point to a plane: positive inside. */
  distance(plane: number, point: ReadonlyVec3): number {
    const p = this.planes;
    const i = plane * 4;
    return (
      p[i] * point[0] + p[i + 1] * point[1] + p[i + 2] * point[2] + p[i + 3]
    );
  }

  /**
   * Whether a sphere may touch the frustum. Conservative: a sphere near a
   * corner, outside, can be reported as touching.
   */
  intersectsSphere(center: ReadonlyVec3, radius: number): boolean {
    for (let plane = 0; plane < 6; plane++) {
      if (this.distance(plane, center) < -radius) {
        return false;
      }
    }
    return true;
  }

  /**
   * Where a box is: outside, inside, or across the planes. Conservative: a
   * box near an edge, outside, can be reported as intersecting. 'inside'
   * lets a spatial index accept a whole cell without testing its items.
   */
  classifyBox(min: ReadonlyVec3, max: ReadonlyVec3): Classification {
    return this.classify(min[0], min[1], min[2], max[0], max[1], max[2]);
  }

  classifyAabb(box: Aabb): Classification {
    return this.classifyBox(box.min, box.max);
  }

  /**
   * classifyBox() for a box stored flat at an offset of an array (min x, y,
   * z, max x, y, z): the bounds of a spatial index or of a table.
   */
  classifyBounds(bounds: ArrayLike<number>, offset: number): Classification {
    return this.classify(
      bounds[offset],
      bounds[offset + 1],
      bounds[offset + 2],
      bounds[offset + 3],
      bounds[offset + 4],
      bounds[offset + 5],
    );
  }

  private classify(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
  ): Classification {
    const p = this.planes;
    let inside = true;
    for (let i = 0; i < 24; i += 4) {
      const nx = p[i];
      const ny = p[i + 1];
      const nz = p[i + 2];
      const d = p[i + 3];
      // The corners farthest along the normal, and against it.
      const far =
        nx * (nx >= 0 ? maxX : minX) +
        ny * (ny >= 0 ? maxY : minY) +
        nz * (nz >= 0 ? maxZ : minZ) +
        d;
      if (far < 0) {
        return 'outside';
      }
      const near =
        nx * (nx >= 0 ? minX : maxX) +
        ny * (ny >= 0 ? minY : maxY) +
        nz * (nz >= 0 ? minZ : maxZ) +
        d;
      if (near < 0) {
        inside = false;
      }
    }
    return inside ? 'inside' : 'intersects';
  }

  /** The eight corners: near then far, each (left, right) × (bottom, top). */
  corners(): readonly ReadonlyVec3[] {
    if (!this._corners) {
      const corners: Vec3[] = [];
      for (const depth of [Near, Far]) {
        for (const side of [Left, Right]) {
          for (const height of [Bottom, Top]) {
            corners.push(this.intersectPlanes(depth, side, height));
          }
        }
      }
      this._corners = corners;
    }
    return this._corners;
  }

  // The point common to three planes.
  private intersectPlanes(a: number, b: number, c: number): Vec3 {
    const p = this.planes;
    set(n1, p[a * 4], p[a * 4 + 1], p[a * 4 + 2]);
    set(n2, p[b * 4], p[b * 4 + 1], p[b * 4 + 2]);
    set(n3, p[c * 4], p[c * 4 + 1], p[c * 4 + 2]);
    cross(c23, n2, n3);
    cross(c31, n3, n1);
    cross(c12, n1, n2);
    const determinant = dot(n1, c23);
    const out = scale(vec3(), c23, -p[a * 4 + 3]);
    scaleAndAdd(out, out, c31, -p[b * 4 + 3]);
    scaleAndAdd(out, out, c12, -p[c * 4 + 3]);
    return scale(out, out, 1 / determinant);
  }

  bounds(out: Aabb = new Aabb()): Aabb {
    out.makeEmpty();
    for (const corner of this.corners()) {
      out.expandByPoint(corner);
    }
    return out;
  }

  transform(matrix: Matrix4): Frustum {
    // A plane P (a row) becomes P × M⁻¹.
    const inverse = invert(matrix);
    const frustum = new Frustum();
    if (!inverse) {
      return frustum;
    }
    for (let plane = 0; plane < 6; plane++) {
      for (let column = 0; column < 4; column++) {
        let sum = 0;
        for (let i = 0; i < 4; i++) {
          sum += this.planes[plane * 4 + i] * inverse[column * 4 + i];
        }
        frustum.planes[plane * 4 + column] = sum;
      }
    }
    return frustum.normalizePlanes();
  }

  containsPoint(point: ReadonlyVec3): boolean {
    for (let plane = 0; plane < 6; plane++) {
      if (this.distance(plane, point) < 0) {
        return false;
      }
    }
    return true;
  }

  raycast(ray: Ray): number | undefined {
    // Clips the ray by each plane (Cyrus-Beck).
    const p = this.planes;
    let near = 0;
    let far = Infinity;
    for (let i = 0; i < 24; i += 4) {
      const facing =
        p[i] * ray.direction[0] +
        p[i + 1] * ray.direction[1] +
        p[i + 2] * ray.direction[2];
      const distance = this.distance(i / 4, ray.origin);
      if (facing === 0) {
        if (distance < 0) {
          return undefined;
        }
        continue;
      }
      const t = -distance / facing;
      if (facing > 0) {
        near = Math.max(near, t);
      } else {
        far = Math.min(far, t);
      }
      if (near > far) {
        return undefined;
      }
    }
    return near;
  }

  support(direction: ReadonlyVec3, out: Vec3): Vec3 {
    let best = -Infinity;
    for (const corner of this.corners()) {
      const d = dot(corner, direction);
      if (d > best) {
        best = d;
        set(out, corner[0], corner[1], corner[2]);
      }
    }
    return out;
  }
}
