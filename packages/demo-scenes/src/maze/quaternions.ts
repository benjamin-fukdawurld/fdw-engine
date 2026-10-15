// Rotations as unit quaternions ({ x, y, z, w }), for the cameras and the
// characters of the game.

export interface Quat {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

/** a × b: the rotation b, then a. */
export function multiplyQuat(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/** A rotation of `angle` radians around the x, y or z axis. */
export function rotationAround(axis: 'x' | 'y' | 'z', angle: number): Quat {
  return {
    x: axis === 'x' ? Math.sin(angle / 2) : 0,
    y: axis === 'y' ? Math.sin(angle / 2) : 0,
    z: axis === 'z' ? Math.sin(angle / 2) : 0,
    w: Math.cos(angle / 2),
  };
}
