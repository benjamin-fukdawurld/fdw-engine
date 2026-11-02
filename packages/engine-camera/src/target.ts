/** A point or a direction. */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/**
 * What an operator moves: a `Camera` of engine-core, the `transform` of the
 * node of a camera in a scene, or anything with a position and a rotation.
 * Looking along its -z axis, y up.
 */
export interface CameraTarget {
  position: Vec3Like;
  rotation: { x: number; y: number; z: number; w: number };
  /**
   * Its projection, when it has one (a `Camera`): the operators read its
   * field of view and its aspect, to follow the pointer exactly.
   */
  readonly projection?: {
    readonly type: string;
    readonly fov?: number;
    readonly aspect?: number;
    /** The extents of an orthographic projection. */
    readonly left?: number;
    readonly right?: number;
    readonly bottom?: number;
    readonly top?: number;
  };
}

/** The field of view (vertical, in degrees) and aspect when not known. */
export const DefaultView = { fov: 45, aspect: 1 } as const;

/**
 * The vertical field of view in radians, and the aspect, of a target (the
 * aspect of its extents when orthographic), into `out`.
 */
export function viewOf(
  target: CameraTarget,
  out: { fov: number; aspect: number } = { fov: 0, aspect: 0 },
): { fov: number; aspect: number } {
  const projection = target.projection;
  const perspective = projection?.type === 'perspective';
  const fov = (perspective && projection?.fov) || DefaultView.fov;
  let aspect = (perspective && projection?.aspect) || DefaultView.aspect;
  if (projection?.type === 'orthographic') {
    const { left = 0, right = 0, bottom = 0, top = 0 } = projection;
    const width = Math.abs(right - left);
    const height = Math.abs(top - bottom);
    if (width > 0 && height > 0) {
      aspect = width / height;
    }
  }
  out.fov = (fov * Math.PI) / 180;
  out.aspect = aspect;
  return out;
}

/**
 * The height of the view of a target at `distance` in front of it: what
 * the pointer crossing the view from bottom to top covers there. The
 * height of its extents when orthographic, whatever the distance.
 */
export function viewHeight(target: CameraTarget, distance: number): number {
  const p = target.projection;
  if (
    p?.type === 'orthographic' &&
    p.top !== undefined &&
    p.bottom !== undefined
  ) {
    const height = Math.abs(p.top - p.bottom);
    if (height > 0) {
      return height;
    }
  }
  const perspective = p?.type === 'perspective';
  const fov = (perspective && p?.fov) || DefaultView.fov;
  return 2 * distance * Math.tan((fov * Math.PI) / 360);
}

/**
 * The rotation of a camera turned by `yaw` around y (positive: to the
 * left), then by `pitch` around its x axis (positive: up).
 */
export function rotationOf(
  yaw: number,
  pitch: number,
): { x: number; y: number; z: number; w: number } {
  const sy = Math.sin(yaw / 2);
  const cy = Math.cos(yaw / 2);
  const sp = Math.sin(pitch / 2);
  const cp = Math.cos(pitch / 2);
  return { x: cy * sp, y: sy * cp, z: -sy * sp, w: cy * cp };
}

/** Where a camera of this yaw and pitch looks: its -z axis. */
export function forwardOf(yaw: number, pitch: number, out: Vec3Like): Vec3Like {
  out.x = -Math.sin(yaw) * Math.cos(pitch);
  out.y = Math.sin(pitch);
  out.z = -Math.cos(yaw) * Math.cos(pitch);
  return out;
}

/** The right of a camera of this yaw: its x axis, always horizontal. */
export function rightOf(yaw: number, out: Vec3Like): Vec3Like {
  out.x = Math.cos(yaw);
  out.y = 0;
  out.z = -Math.sin(yaw);
  return out;
}

/** The up of a camera of this yaw and pitch: its y axis. */
export function upOf(yaw: number, pitch: number, out: Vec3Like): Vec3Like {
  out.x = Math.sin(yaw) * Math.sin(pitch);
  out.y = Math.cos(pitch);
  out.z = Math.cos(yaw) * Math.sin(pitch);
  return out;
}

/** Just short of vertical: past it, the yaw has no meaning. */
export const MaxPitch = (89 * Math.PI) / 180;

export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));
