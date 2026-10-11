import { Ray } from '@fdw/engine-geometry';
import type { ComponentStore, Scene } from '@fdw/engine-scene';

const ray = new Ray([0, 0, 0], [0, 0, -1]);

/**
 * Whether nothing solid stands between two points: a ray of the scene from
 * one to the other, stopped by the first entity with the `solid`
 * component. The others (the floor, the characters) do not hide.
 */
export function clearLine(
  scene: Scene,
  solid: ComponentStore,
  from: { readonly x: number; readonly y: number; readonly z: number },
  to: { readonly x: number; readonly y: number; readonly z: number }
): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const distance = Math.hypot(dx, dy, dz);
  if (distance === 0) {
    return true;
  }
  ray.origin[0] = from.x;
  ray.origin[1] = from.y;
  ray.origin[2] = from.z;
  ray.direction[0] = dx / distance;
  ray.direction[1] = dy / distance;
  ray.direction[2] = dz / distance;
  let clear = true;
  scene.raycastEntities(
    ray,
    (entity) => {
      if (solid.has(entity)) {
        clear = false;
        return false;
      }
      return true;
    },
    {},
    distance
  );
  return clear;
}

/**
 * Whether a point is in the cone of a spot light, closer than `reach`: the
 * angle with its axis below its outer cutoff.
 */
export function inCone(
  spot: {
    readonly position: { x: number; y: number; z: number };
    readonly direction: { x: number; y: number; z: number };
    readonly outerCutoff: number;
  },
  point: { readonly x: number; readonly y: number; readonly z: number },
  reach: number
): boolean {
  const { position: p, direction: d } = spot;
  const tx = point.x - p.x;
  const ty = point.y - p.y;
  const tz = point.z - p.z;
  const distance = Math.hypot(tx, ty, tz);
  if (distance > reach) {
    return false;
  }
  // cos(angle) × the lengths, compared without dividing.
  const cos = Math.cos((spot.outerCutoff * Math.PI) / 180);
  return (
    tx * d.x + ty * d.y + tz * d.z >= cos * distance * Math.hypot(d.x, d.y, d.z)
  );
}
