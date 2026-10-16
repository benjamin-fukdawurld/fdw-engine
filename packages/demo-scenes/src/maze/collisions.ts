import { Aabb, Sphere } from '@fdw/engine-geometry';
import type { ComponentStore, Scene } from '@fdw/engine-scene';

const box = new Aabb();
const probe = new Sphere();

/**
 * Moves a circle (a character seen from above, in the xz plane) out of the
 * solid entities it overlaps: the walls near it, found by a query of the
 * scene. Pushed along the shortest way out, it slides along the walls
 * instead of stopping on them. Returns whether it touched one.
 */
export function resolveCircle(
  scene: Scene,
  solid: ComponentStore,
  position: { x: number; y: number; z: number },
  radius: number,
): boolean {
  let touched = false;
  // A few passes: leaving a wall can push into another one, in a corner.
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    probe.center[0] = position.x;
    probe.center[1] = position.y;
    probe.center[2] = position.z;
    probe.radius = radius;
    scene.queryVolumeEntities(probe, (entity) => {
      if (!solid.has(entity)) {
        return;
      }
      scene.bounds(box, entity);
      // The point of the box nearest to the center, in the plane.
      const nx = Math.min(Math.max(position.x, box.min[0]), box.max[0]);
      const nz = Math.min(Math.max(position.z, box.min[2]), box.max[2]);
      const dx = position.x - nx;
      const dz = position.z - nz;
      const distance = Math.hypot(dx, dz);
      if (distance >= radius) {
        return;
      }
      if (distance > 1e-6) {
        // Outside the box: away from its nearest point.
        position.x = nx + (dx / distance) * radius;
        position.z = nz + (dz / distance) * radius;
      } else {
        // The center inside the box: out by the nearest side.
        const exits = [
          {
            axis: 'x',
            to: box.min[0] - radius,
            depth: position.x - box.min[0],
          },
          {
            axis: 'x',
            to: box.max[0] + radius,
            depth: box.max[0] - position.x,
          },
          {
            axis: 'z',
            to: box.min[2] - radius,
            depth: position.z - box.min[2],
          },
          {
            axis: 'z',
            to: box.max[2] + radius,
            depth: box.max[2] - position.z,
          },
        ].sort((a, b) => a.depth - b.depth);
        position[exits[0].axis as 'x' | 'z'] = exits[0].to;
      }
      moved = true;
      touched = true;
    });
    if (!moved) {
      break;
    }
  }
  return touched;
}
