// The handles of the gizmos and their hit tests: analytic, on the CPU, in
// the space of the gizmo (its axes 1 long), against the ray under the
// pointer. No read back of the identifiers: the answer is there at once.
import {
  cross,
  dot,
  normalize,
  type ReadonlyVec3,
  type Vec3,
  vec3,
} from '@fdw/engine-geometry';

/** What a gizmo moves, rotates or scales. */
export type GizmoMode = 'translate' | 'rotate' | 'scale';

/**
 * A handle of a gizmo:
 * - `x`, `y`, `z`: along an axis (translate, scale), around it (rotate);
 * - `yz`, `zx`, `xy`: in the plane of two axes (translate, scale);
 * - `view`: in the plane of the screen (translate), around the direction of
 *   the view (rotate, the outer ring);
 * - `uniform`: the three axes at once (scale, the center).
 */
export type GizmoHandle =
  'x' | 'y' | 'z' | 'yz' | 'zx' | 'xy' | 'view' | 'uniform';

/** The handles of each mode. */
export const GizmoHandles: Readonly<Record<GizmoMode, readonly GizmoHandle[]>> =
  {
    translate: ['x', 'y', 'z', 'yz', 'zx', 'xy', 'view'],
    rotate: ['x', 'y', 'z', 'view'],
    scale: ['x', 'y', 'z', 'yz', 'zx', 'xy', 'uniform'],
  };

/** The axis of an axis handle, or the normal of a plane handle. */
export const handleAxis = (handle: GizmoHandle): 0 | 1 | 2 | undefined =>
  handle === 'x' || handle === 'yz'
    ? 0
    : handle === 'y' || handle === 'zx'
      ? 1
      : handle === 'z' || handle === 'xy'
        ? 2
        : undefined;

export const isPlane = (handle: GizmoHandle): boolean =>
  handle === 'yz' || handle === 'zx' || handle === 'xy';

/** The sizes of the handles, in units of the gizmo (its axes are 1 long). */
export const GizmoShape = {
  // Where the axes start and end.
  axisFrom: 0.2,
  axisTo: 1,
  // The squares of the planes, on both of their axes.
  planeFrom: 0.3,
  planeTo: 0.55,
  // The center: the free move, the uniform scale.
  center: 0.12,
  // The rings of the rotations, and the ring around the view.
  ring: 1,
  viewRing: 1.2,
} as const;

// The axes seen almost end on, the planes almost edge on, are hidden: they
// could not be dragged precisely.
const MaxAxisFacing = 0.97;
const MinPlaneFacing = 0.2;

/**
 * Whether a handle is shown and can be grabbed, for a view direction in the
 * space of the gizmo.
 */
export function handleVisible(
  handle: GizmoHandle,
  view: ReadonlyVec3,
): boolean {
  const axis = handleAxis(handle);
  if (axis === undefined) {
    return true;
  }
  if (isPlane(handle)) {
    return Math.abs(view[axis]) > MinPlaneFacing;
  }
  return true;
}

/** Whether an axis handle of translation or scale is seen almost end on. */
export const axisHidden = (axis: 0 | 1 | 2, view: ReadonlyVec3): boolean =>
  Math.abs(view[axis]) > MaxAxisFacing;

/**
 * The distance between a ray (origin, unit direction) and a segment, and
 * the distance along the ray of the closest point.
 */
export function raySegmentDistance(
  origin: ReadonlyVec3,
  direction: ReadonlyVec3,
  a: ReadonlyVec3,
  b: ReadonlyVec3,
): { distance: number; along: number } {
  const u = direction;
  const v: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const w: Vec3 = [origin[0] - a[0], origin[1] - a[1], origin[2] - a[2]];
  const uu = dot(u, u);
  const uv = dot(u, v);
  const vv = dot(v, v);
  const uw = dot(u, w);
  const vw = dot(v, w);
  const d = uu * vv - uv * uv;
  // s along the ray (≥ 0), t along the segment (0 to 1).
  let s: number;
  let t: number;
  if (d < 1e-12) {
    s = 0;
    t = vv > 0 ? vw / vv : 0;
  } else {
    s = (uv * vw - vv * uw) / d;
    t = (uu * vw - uv * uw) / d;
  }
  t = Math.min(1, Math.max(0, t));
  // The best s for that t, then the best t for that s.
  s = Math.max(0, (t * uv - uw) / uu);
  t = vv > 0 ? Math.min(1, Math.max(0, (s * uv + vw) / vv)) : 0;
  const p: Vec3 = [
    origin[0] + u[0] * s - (a[0] + v[0] * t),
    origin[1] + u[1] * s - (a[1] + v[1] * t),
    origin[2] + u[2] * s - (a[2] + v[2] * t),
  ];
  return { distance: Math.hypot(p[0], p[1], p[2]), along: s };
}

/**
 * Where a ray crosses a plane (a point and a unit normal): the distance
 * along the ray, or undefined when it is parallel or the plane is behind.
 */
export function rayPlane(
  origin: ReadonlyVec3,
  direction: ReadonlyVec3,
  point: ReadonlyVec3,
  normal: ReadonlyVec3,
): number | undefined {
  const denominator = dot(direction, normal);
  if (Math.abs(denominator) < 1e-9) {
    return undefined;
  }
  const t =
    dot(
      [point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]],
      normal,
    ) / denominator;
  return t >= 0 ? t : undefined;
}

/** Two unit vectors perpendicular to a unit normal, and to each other. */
export function basisOf(normal: ReadonlyVec3): [Vec3, Vec3] {
  const helper: Vec3 = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize(vec3(), cross(vec3(), normal, helper));
  const v = cross(vec3(), normal, u);
  return [u, v];
}

/**
 * The distance between a ray and a circle (a center, a unit normal, a
 * radius), measured on a polygon of 64 sides; and the point of the circle
 * nearest to the ray.
 */
export function rayCircleDistance(
  origin: ReadonlyVec3,
  direction: ReadonlyVec3,
  center: ReadonlyVec3,
  normal: ReadonlyVec3,
  radius: number,
): { distance: number; along: number; point: Vec3 } {
  const [u, v] = basisOf(normal);
  const at = (i: number): Vec3 => {
    const a = (i / 64) * Math.PI * 2;
    const c = Math.cos(a) * radius;
    const s = Math.sin(a) * radius;
    return [
      center[0] + u[0] * c + v[0] * s,
      center[1] + u[1] * c + v[1] * s,
      center[2] + u[2] * c + v[2] * s,
    ];
  };
  let best = { distance: Infinity, along: 0, point: at(0) };
  let previous = at(0);
  for (let i = 1; i <= 64; i++) {
    const next = at(i);
    const hit = raySegmentDistance(origin, direction, previous, next);
    if (hit.distance < best.distance) {
      best = { ...hit, point: previous };
    }
    previous = next;
  }
  return best;
}

/** A handle under the ray, and how far from it (0: inside). */
export interface GizmoHit {
  readonly handle: GizmoHandle;
  readonly distance: number;
}

/**
 * The handle of a gizmo under a ray, in the space of the gizmo: the nearest
 * within the tolerance (in units of the gizmo), the center first on a tie.
 * `view` is the direction of the view, in the same space.
 */
export function hitHandles(
  mode: GizmoMode,
  origin: ReadonlyVec3,
  direction: ReadonlyVec3,
  view: ReadonlyVec3,
  tolerance: number,
): GizmoHit | undefined {
  const hits: GizmoHit[] = [];
  const zero: ReadonlyVec3 = [0, 0, 0];
  const unit = (axis: number, length: number): Vec3 => {
    const p: Vec3 = [0, 0, 0];
    p[axis] = length;
    return p;
  };
  for (const handle of GizmoHandles[mode]) {
    const axis = handleAxis(handle);
    if (!handleVisible(handle, view)) {
      continue;
    }
    let distance: number;
    if (handle === 'view' && mode === 'rotate') {
      distance = Math.abs(
        rayCircleDistance(origin, direction, zero, view, GizmoShape.viewRing)
          .distance,
      );
    } else if (handle === 'view' || handle === 'uniform') {
      distance = Math.max(
        0,
        raySegmentDistance(origin, direction, zero, zero).distance -
          GizmoShape.center,
      );
    } else if (mode === 'rotate') {
      distance = rayCircleDistance(
        origin,
        direction,
        zero,
        unit(axis as number, 1),
        GizmoShape.ring,
      ).distance;
    } else if (isPlane(handle)) {
      const normal = unit(axis as number, 1);
      const t = rayPlane(origin, direction, zero, normal);
      if (t === undefined) {
        continue;
      }
      // The coordinates in the plane, on its two axes.
      const p = [
        origin[0] + direction[0] * t,
        origin[1] + direction[1] * t,
        origin[2] + direction[2] * t,
      ];
      const a = p[((axis as number) + 1) % 3];
      const b = p[((axis as number) + 2) % 3];
      const outside = (c: number) =>
        Math.max(0, GizmoShape.planeFrom - c, c - GizmoShape.planeTo);
      distance = Math.hypot(outside(a), outside(b));
    } else {
      if (axisHidden(axis as 0 | 1 | 2, view)) {
        continue;
      }
      distance = raySegmentDistance(
        origin,
        direction,
        unit(axis as number, GizmoShape.axisFrom),
        unit(axis as number, GizmoShape.axisTo),
      ).distance;
    }
    if (distance <= tolerance) {
      hits.push({ handle, distance });
    }
  }
  const center = (h: GizmoHit) =>
    h.handle === 'view' || h.handle === 'uniform' ? 0 : 1;
  hits.sort((a, b) => a.distance - b.distance || center(a) - center(b));
  return hits[0];
}
