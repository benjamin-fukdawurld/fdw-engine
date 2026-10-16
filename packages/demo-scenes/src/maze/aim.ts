import type { Camera } from '@fdw/engine-core';
import type { ActionMap, Input } from '@fdw/engine-input';

/**
 * Where the pointer points on a horizontal plane (y = height): the ray from
 * the camera through the pointer, cut by the plane. `camera` is a world
 * matrix (the node of a camera: it looks along its -z axis); `pointer` is
 * in [0, 1] over the surface, from the top left. Undefined when the ray
 * does not go down to the plane.
 */
export function pointerOnPlane(
  world: ArrayLike<number>,
  camera: Camera,
  pointer: { readonly x: number; readonly y: number },
  height = 0,
): { x: number; z: number } | undefined {
  const projection = camera.projection;
  if (projection.type !== 'perspective') {
    return undefined;
  }
  // The pointer in the image plane at distance 1, in the space of the
  // camera, then in the world.
  const tan = Math.tan((projection.fov * Math.PI) / 360);
  const sx = (pointer.x * 2 - 1) * tan * projection.aspect;
  const sy = (1 - pointer.y * 2) * tan;
  const direction = [0, 1, 2].map(
    (i) => world[i] * sx + world[4 + i] * sy - world[8 + i],
  );
  const origin = [world[12], world[13], world[14]];
  if (direction[1] >= -1e-6) {
    return undefined;
  }
  const t = (height - origin[1]) / direction[1];
  return { x: origin[0] + direction[0] * t, z: origin[2] + direction[2] * t };
}

/**
 * Where the character aims: the point of the ground under the pointer, or
 * the direction of the `aim` action (the right stick), turned by the
 * camera — the one used last. Undefined when nothing aims (the stick at
 * rest): the character faces where it walks.
 */
export class Aim {
  private _mode: 'none' | 'pointer' | 'stick' = 'none';
  private readonly _stick = { x: 0, y: 0 };

  update(
    input: Input,
    actions: ActionMap,
    eye: { readonly worldMatrix: ArrayLike<number> },
    camera: Camera,
    around: { readonly x: number; readonly z: number },
    cameraYaw: number,
  ): { x: number; z: number } | undefined {
    const { x, y } = actions.vector('aim', this._stick);
    const pushed = Math.hypot(x, y) > 0.3;
    if (pushed) {
      this._mode = 'stick';
    } else if (input.pointer.moved) {
      this._mode = 'pointer';
    }
    if (this._mode === 'pointer') {
      return pointerOnPlane(eye.worldMatrix, camera, input.pointer);
    }
    if (this._mode === 'stick' && pushed) {
      // As the movement: in the frame of the camera, then in the world; a
      // point a few units away in that direction.
      const sin = Math.sin(cameraYaw);
      const cos = Math.cos(cameraYaw);
      return {
        x: around.x + (x * cos - y * sin) * 3,
        z: around.z + (-x * sin - y * cos) * 3,
      };
    }
    return undefined;
  }
}
