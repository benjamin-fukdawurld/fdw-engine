import type { ReadonlyVec3, Vec3 } from '../math';
import type { Aabb } from './Aabb';
import type { Capsule } from './Capsule';
import type { Obb } from './Obb';
import type { Sphere } from './Sphere';
import type { Volume } from './Volume';

const local = [0, 0, 0];
const gradient = [0, 0, 0];

// The signed distance to a box centered at the origin, of half extents
// (hx, hy, hz), at (x, y, z); its gradient in `gradient`.
function boxDistance(
  x: number,
  y: number,
  z: number,
  hx: number,
  hy: number,
  hz: number,
): number {
  const qx = Math.abs(x) - hx;
  const qy = Math.abs(y) - hy;
  const qz = Math.abs(z) - hz;
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  const oz = Math.max(qz, 0);
  const outside = Math.hypot(ox, oy, oz);
  if (outside > 0) {
    gradient[0] = (Math.sign(x) * ox) / outside;
    gradient[1] = (Math.sign(y) * oy) / outside;
    gradient[2] = (Math.sign(z) * oz) / outside;
    return outside;
  }
  // Inside: out through the nearest face.
  gradient[0] = gradient[1] = gradient[2] = 0;
  if (qx >= qy && qx >= qz) {
    gradient[0] = x < 0 ? -1 : 1;
    return qx;
  }
  if (qy >= qz) {
    gradient[1] = y < 0 ? -1 : 1;
    return qy;
  }
  gradient[2] = z < 0 ? -1 : 1;
  return qz;
}

/**
 * The signed distance from a point to a volume: positive outside, negative
 * inside (the depth), and in `normal` the direction that leaves the
 * volume fastest. Exact for the boxes, the oriented boxes, the spheres and
 * the capsules; the other volumes give undefined.
 */
export function signedDistance(
  volume: Volume,
  point: ReadonlyVec3,
  normal?: Vec3,
): number | undefined {
  let distance: number;
  switch (volume.kind) {
    case 'aabb': {
      const box = volume as Aabb;
      const { min, max } = box;
      distance = boxDistance(
        point[0] - (min[0] + max[0]) / 2,
        point[1] - (min[1] + max[1]) / 2,
        point[2] - (min[2] + max[2]) / 2,
        (max[0] - min[0]) / 2,
        (max[1] - min[1]) / 2,
        (max[2] - min[2]) / 2,
      );
      break;
    }
    case 'obb': {
      const box = volume as Obb;
      const dx = point[0] - box.center[0];
      const dy = point[1] - box.center[1];
      const dz = point[2] - box.center[2];
      for (let i = 0; i < 3; i++) {
        const a = box.axes[i];
        local[i] = dx * a[0] + dy * a[1] + dz * a[2];
      }
      const h = box.halfExtents;
      distance = boxDistance(local[0], local[1], local[2], h[0], h[1], h[2]);
      // Back to the world.
      const [gx, gy, gz] = gradient;
      for (let c = 0; c < 3; c++) {
        gradient[c] =
          box.axes[0][c] * gx + box.axes[1][c] * gy + box.axes[2][c] * gz;
      }
      break;
    }
    case 'sphere': {
      const sphere = volume as Sphere;
      const dx = point[0] - sphere.center[0];
      const dy = point[1] - sphere.center[1];
      const dz = point[2] - sphere.center[2];
      const d = Math.hypot(dx, dy, dz);
      if (d > 0) {
        gradient[0] = dx / d;
        gradient[1] = dy / d;
        gradient[2] = dz / d;
      } else {
        gradient[0] = gradient[2] = 0;
        gradient[1] = 1;
      }
      distance = d - sphere.radius;
      break;
    }
    case 'capsule': {
      const capsule = volume as Capsule;
      const { start, end } = capsule;
      const ex = end[0] - start[0];
      const ey = end[1] - start[1];
      const ez = end[2] - start[2];
      const l2 = ex * ex + ey * ey + ez * ez;
      const t =
        l2 > 0
          ? Math.min(
              Math.max(
                ((point[0] - start[0]) * ex +
                  (point[1] - start[1]) * ey +
                  (point[2] - start[2]) * ez) /
                  l2,
                0,
              ),
              1,
            )
          : 0;
      const dx = point[0] - (start[0] + ex * t);
      const dy = point[1] - (start[1] + ey * t);
      const dz = point[2] - (start[2] + ez * t);
      const d = Math.hypot(dx, dy, dz);
      if (d > 0) {
        gradient[0] = dx / d;
        gradient[1] = dy / d;
        gradient[2] = dz / d;
      } else {
        gradient[0] = gradient[2] = 0;
        gradient[1] = 1;
      }
      distance = d - capsule.radius;
      break;
    }
    default:
      return undefined;
  }
  if (normal) {
    normal[0] = gradient[0];
    normal[1] = gradient[1];
    normal[2] = gradient[2];
  }
  return distance;
}
