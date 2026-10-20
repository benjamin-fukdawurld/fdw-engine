import {
  Aabb,
  dot,
  invert,
  type Matrix4,
  transformPoint,
  type Vec3,
} from '@fdw/engine-geometry';
import { TransformCommand } from '../commands/commands';
import type { History } from '../history/History';
import {
  axisAngle,
  conjugate,
  decompose,
  multiplyQuat,
  normalizeQuat,
  type Quat,
  rotate,
  snap,
  type Trs,
} from '../math';
import {
  type Editable,
  isAlive,
  parentMatrix,
  topmost,
  transformOf,
  worldBounds,
  worldMatrix,
  writeTrs,
} from '../targets';
import type { Viewport, ViewportPoint } from '../Viewport';
import {
  type GizmoHandle,
  type GizmoMode,
  handleAxis,
  hitHandles,
  isPlane,
  rayCircleDistance,
  rayPlane,
} from './handles';

/** The axes of the gizmo: those of the world, or those of the active object. */
export type GizmoSpace = 'world' | 'local';

/**
 * What the gizmo turns and scales around: the center of the bounds of the
 * selection (everything around it), or the origin of each object (the
 * gizmo at that of the active one).
 */
export type GizmoPivot = 'center' | 'origin';

/** The steps of the snapping; undefined: none for that mode. */
export interface GizmoSnap {
  /** Units of the world. */
  readonly translate?: number;
  /** Degrees. */
  readonly rotate?: number;
  /** A factor: 0.1 scales by 10 % steps. */
  readonly scale?: number;
}

/** Where the gizmo is: its origin, its axes (unit), its scale in the world. */
export interface GizmoFrame {
  readonly origin: Vec3;
  readonly axes: readonly [Vec3, Vec3, Vec3];
  readonly rotation: Quat;
  readonly scale: number;
}

export interface TransformGizmoOptions {
  readonly mode?: GizmoMode;
  readonly space?: GizmoSpace;
  readonly pivot?: GizmoPivot;
  readonly snap?: GizmoSnap;
  /** Whether the snapping is on (the Ctrl key inverts it during a drag). */
  readonly snapping?: boolean;
  /** The length of the axes on screen, in pixels. Default 110. */
  readonly size?: number;
  /** Where the drags are recorded, one entry each. */
  readonly history?: History;
}

// A drag in progress: what it started from.
interface Drag {
  readonly handle: GizmoHandle;
  readonly targets: Editable[];
  readonly before: Trs[];
  // The world position and rotation of each target at the start.
  readonly positions: Vec3[];
  readonly rotations: Quat[];
  readonly frame: GizmoFrame;
  readonly start: ViewportPoint;
  // The point grabbed: on the axis line (its parameter), in the plane, or
  // the vector from the pivot in the plane of a ring.
  readonly grab: Vec3 | number;
  // Rotation: the tangent of the ring on screen, when it is seen edge on.
  readonly tangent?: { x: number; y: number };
  // Rotation: the axis, and the angle summed so far (planar method).
  readonly axis: Vec3;
  angle: number;
  previous?: Vec3;
  moved: boolean;
}

const labels: Record<GizmoMode, string> = {
  translate: 'Move',
  rotate: 'Rotate',
  scale: 'Scale',
};

/**
 * The gizmo of translation, rotation and scale of a selection: its handles
 * by axis, by plane, in the plane of the screen or uniform; in the axes of
 * the world or of the active object; around the center of the selection or
 * the origin of each object; with snapping; of a constant size on screen.
 *
 * Its hover and grab are tested on the CPU, against the ray under the
 * pointer (see handles.ts): no read back. A drag moves the objects at each
 * step, and records one command at the end (one entry of the history).
 *
 * ```ts
 * const gizmo = new TransformGizmo({ history });
 * gizmo.targets = selection.items;
 * // pointerdown: grab a handle, if one is under the pointer.
 * if (gizmo.begin(viewport, point)) { … }
 * // pointermove:
 * gizmo.dragging ? gizmo.drag(viewport, point) : gizmo.hover(viewport, point);
 * // pointerup:
 * gizmo.end();
 * ```
 *
 * The scale is always along the axes of the objects (`space` is ignored):
 * a scale along an axis of the world would shear a turned object, which
 * its transform cannot hold.
 */
export class TransformGizmo {
  mode: GizmoMode;
  space: GizmoSpace;
  pivot: GizmoPivot;
  snap: GizmoSnap;
  snapping: boolean;
  size: number;
  history?: History;
  /** Hidden, the gizmo is not drawn and cannot be grabbed. */
  visible = true;
  /** The handle under the pointer. */
  hovered: GizmoHandle | undefined;
  private _targets: readonly Editable[] = [];
  private _drag?: Drag;

  constructor(options: TransformGizmoOptions = {}) {
    this.mode = options.mode ?? 'translate';
    this.space = options.space ?? 'world';
    this.pivot = options.pivot ?? 'center';
    this.snap = options.snap ?? { translate: 0.5, rotate: 15, scale: 0.1 };
    this.snapping = options.snapping ?? false;
    this.size = options.size ?? 110;
    this.history = options.history;
  }

  /** What the gizmo transforms; the last one is the active object. */
  get targets(): readonly Editable[] {
    return this._targets;
  }

  set targets(targets: readonly Editable[]) {
    if (this._drag) {
      this.cancel();
    }
    this._targets = [...targets];
  }

  /** The targets still alive (a node removed is skipped). */
  private alive(): Editable[] {
    return this._targets.filter(isAlive);
  }

  /** Whether the gizmo is shown: visible, with targets. */
  get shown(): boolean {
    return this.visible && this.alive().length > 0;
  }

  /** The handle being dragged. */
  get active(): GizmoHandle | undefined {
    return this._drag?.handle;
  }

  get dragging(): boolean {
    return this._drag !== undefined;
  }

  /** Where the gizmo is now, for a viewport; undefined without targets. */
  frame(viewport: Viewport): GizmoFrame | undefined {
    const targets = this.alive();
    const active = targets.at(-1);
    if (!active) {
      return undefined;
    }
    let origin: Vec3;
    if (this._drag && this.mode !== 'translate') {
      // The pivot stays where the drag started.
      origin = this._drag.frame.origin;
    } else if (this.pivot === 'origin') {
      const m = worldMatrix(active);
      origin = [m[12], m[13], m[14]];
    } else {
      const box = new Aabb().makeEmpty();
      const one = new Aabb();
      for (const target of topmost(targets)) {
        box.union(worldBounds(target, one));
      }
      origin = box.center();
    }
    const rotation: Quat =
      this.space === 'local' || this.mode === 'scale'
        ? decompose(worldMatrix(active)).rotation
        : [0, 0, 0, 1];
    const axes: [Vec3, Vec3, Vec3] = [
      rotate(rotation, [1, 0, 0]),
      rotate(rotation, [0, 1, 0]),
      rotate(rotation, [0, 0, 1]),
    ];
    return {
      origin,
      axes,
      rotation,
      scale: this.size * viewport.worldPerPixel(origin),
    };
  }

  /**
   * The handle under a point of the viewport, if any: within `tolerance`
   * pixels (8 by default; give more for a finger).
   */
  hitTest(
    viewport: Viewport,
    point: ViewportPoint,
    tolerance = 8,
  ): GizmoHandle | undefined {
    if (!this.shown) {
      return undefined;
    }
    const frame = this.frame(viewport) as GizmoFrame;
    const ray = viewport.ray(point);
    const local = toGizmo(frame, ray.origin, ray.direction);
    const view = toGizmoDirection(frame, viewport.direction(frame.origin));
    return hitHandles(
      this.mode,
      local.origin,
      local.direction,
      view,
      tolerance / this.size,
    )?.handle;
  }

  /** Updates the hovered handle (not during a drag); returns it. */
  hover(
    viewport: Viewport,
    point: ViewportPoint | undefined,
    tolerance?: number,
  ): GizmoHandle | undefined {
    if (!this._drag) {
      this.hovered = point && this.hitTest(viewport, point, tolerance);
    }
    return this.hovered;
  }

  /**
   * Starts a drag of the handle under a point (or of `handle`): returns
   * false when there is none, and the pointer is free for the selection.
   */
  begin(
    viewport: Viewport,
    point: ViewportPoint,
    { handle, tolerance }: { handle?: GizmoHandle; tolerance?: number } = {},
  ): boolean {
    if (this._drag) {
      this.cancel();
    }
    const grabbed = handle ?? this.hitTest(viewport, point, tolerance);
    const frame = this.frame(viewport);
    if (!grabbed || !frame) {
      return false;
    }
    const targets = topmost(this.alive());
    const before = TransformCommand.capture(targets);
    const worlds = targets.map((target) => decompose(worldMatrix(target)));
    const ray = viewport.ray(point);
    const axis = this.dragAxis(grabbed, frame, viewport);
    let grab: Vec3 | number = 0;
    let tangent: { x: number; y: number } | undefined;
    const kind = this.kind(grabbed);
    if (kind === 'line') {
      grab = lineParameter(frame.origin, axis, ray.origin, ray.direction);
    } else if (kind === 'plane') {
      grab =
        planePoint(frame.origin, axis, ray.origin, ray.direction) ??
        frame.origin;
    } else if (kind === 'ring') {
      const planar =
        Math.abs(dot(axis, viewport.direction(frame.origin))) > 0.25;
      const hit = planePoint(frame.origin, axis, ray.origin, ray.direction);
      if (planar && hit) {
        grab = sub(hit, frame.origin);
      } else {
        // Edge on: the angle follows the pointer along the tangent of the
        // ring on screen, where it was grabbed.
        const radius = (grabbed === 'view' ? 1.2 : 1) * frame.scale;
        const on = rayCircleDistance(
          ray.origin,
          ray.direction,
          frame.origin,
          axis,
          radius,
        ).point;
        const r = sub(on, frame.origin);
        const t = cross3(axis, r);
        const a = viewport.project(on);
        const b = viewport.project(add(on, scaleVec(t, 0.01 / (len(t) || 1))));
        const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        tangent = { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
      }
    }
    this._drag = {
      handle: grabbed,
      targets,
      before,
      positions: worlds.map((w) => w.position),
      rotations: worlds.map((w) => w.rotation),
      frame,
      start: point,
      grab,
      tangent,
      axis,
      angle: 0,
      previous: typeof grab === 'number' ? undefined : grab,
      moved: false,
    };
    this.hovered = grabbed;
    return true;
  }

  /**
   * Moves the drag to a point of the viewport: the targets follow at once.
   * `invertSnap` (the Ctrl key held) inverts `snapping` for this step.
   */
  drag(
    viewport: Viewport,
    point: ViewportPoint,
    { invertSnap = false }: { invertSnap?: boolean } = {},
  ): void {
    const drag = this._drag;
    if (!drag) {
      return;
    }
    const snapping = this.snapping !== invertSnap;
    const ray = viewport.ray(point);
    const { frame } = drag;
    const kind = this.kind(drag.handle);
    switch (this.mode) {
      case 'translate': {
        let delta: Vec3;
        if (kind === 'line') {
          const t =
            lineParameter(frame.origin, drag.axis, ray.origin, ray.direction) -
            (drag.grab as number);
          delta = scaleVec(
            drag.axis,
            snapping ? snap(t, this.snap.translate) : t,
          );
        } else {
          const hit = planePoint(
            frame.origin,
            drag.axis,
            ray.origin,
            ray.direction,
          );
          if (!hit) {
            return;
          }
          delta = sub(hit, drag.grab as Vec3);
          if (snapping) {
            // Snapped on the axes of the gizmo.
            delta = frame.axes.reduce<Vec3>(
              (sum, a) =>
                add(sum, scaleVec(a, snap(dot(delta, a), this.snap.translate))),
              [0, 0, 0],
            );
          }
        }
        this.apply(drag, (i) => ({
          position: add(drag.positions[i], delta),
          rotation: drag.rotations[i],
        }));
        break;
      }
      case 'rotate': {
        if (drag.tangent) {
          const moved =
            (point.x - drag.start.x) * drag.tangent.x +
            (point.y - drag.start.y) * drag.tangent.y;
          drag.angle = moved / this.size;
        } else {
          const hit = planePoint(
            frame.origin,
            drag.axis,
            ray.origin,
            ray.direction,
          );
          if (!hit || !drag.previous) {
            return;
          }
          const v = sub(hit, frame.origin);
          const p = drag.previous;
          // Summed step by step: more than half a turn is kept.
          drag.angle += Math.atan2(dot(drag.axis, cross3(p, v)), dot(p, v));
          drag.previous = v;
        }
        const step = this.snap.rotate && (this.snap.rotate * Math.PI) / 180;
        const angle = snapping ? snap(drag.angle, step) : drag.angle;
        const q = axisAngle(drag.axis, angle);
        this.apply(drag, (i) => {
          const center =
            this.pivot === 'origin' ? drag.positions[i] : frame.origin;
          return {
            position: add(center, rotate(q, sub(drag.positions[i], center))),
            rotation: normalizeQuat(multiplyQuat(q, drag.rotations[i])),
          };
        });
        break;
      }
      case 'scale': {
        // A factor per axis of the gizmo: dragging by the length of an
        // axis doubles.
        let factor: number;
        if (kind === 'line') {
          factor =
            1 +
            (lineParameter(frame.origin, drag.axis, ray.origin, ray.direction) -
              (drag.grab as number)) /
              frame.scale;
        } else if (drag.handle === 'uniform') {
          factor =
            1 + (point.x - drag.start.x - (point.y - drag.start.y)) / this.size;
        } else {
          const hit = planePoint(
            frame.origin,
            drag.axis,
            ray.origin,
            ray.direction,
          );
          if (!hit) {
            return;
          }
          const axis = handleAxis(drag.handle) as number;
          const diagonal = normalizeVec(
            add(frame.axes[(axis + 1) % 3], frame.axes[(axis + 2) % 3]),
          );
          factor = 1 + dot(sub(hit, drag.grab as Vec3), diagonal) / frame.scale;
        }
        if (snapping) {
          factor = 1 + snap(factor - 1, this.snap.scale);
        }
        factor = Math.max(factor, 0.01);
        const factors = this.scaleFactors(drag.handle, factor);
        this.apply(
          drag,
          (i) => {
            const center =
              this.pivot === 'origin' ? drag.positions[i] : frame.origin;
            const offset = sub(drag.positions[i], center);
            // The offset scaled along the axes of the gizmo.
            const scaled = frame.axes.reduce<Vec3>(
              (sum, a, k) => add(sum, scaleVec(a, dot(offset, a) * factors[k])),
              [0, 0, 0],
            );
            return {
              position: add(center, scaled),
              rotation: drag.rotations[i],
            };
          },
          factors,
        );
        break;
      }
    }
  }

  /**
   * Ends the drag: records one command in the history (if the gizmo has
   * one and the targets moved), and returns it.
   */
  end(): TransformCommand | undefined {
    const drag = this._drag;
    this._drag = undefined;
    if (!drag?.moved) {
      return undefined;
    }
    const count = drag.targets.length;
    const command = new TransformCommand(
      count === 1 ? labels[this.mode] : `${labels[this.mode]} ${count} objects`,
      drag.targets,
      drag.before,
      TransformCommand.capture(drag.targets),
    );
    this.history?.record(command);
    return command;
  }

  /** Cancels the drag: the targets go back where they were (Escape). */
  cancel(): void {
    const drag = this._drag;
    this._drag = undefined;
    drag?.targets.forEach((target, i) => {
      if (isAlive(target)) {
        writeTrs(transformOf(target), drag.before[i]);
      }
    });
  }

  // How a handle is dragged: along a line, in a plane, around a ring.
  private kind(handle: GizmoHandle): 'line' | 'plane' | 'ring' | 'center' {
    if (this.mode === 'rotate') {
      return 'ring';
    }
    if (handle === 'uniform') {
      return 'center';
    }
    return handle === 'view' || isPlane(handle) ? 'plane' : 'line';
  }

  // The axis of the line, the normal of the plane, the axis of the ring.
  private dragAxis(
    handle: GizmoHandle,
    frame: GizmoFrame,
    viewport: Viewport,
  ): Vec3 {
    const axis = handleAxis(handle);
    if (axis !== undefined) {
      return frame.axes[axis];
    }
    // The view: toward the camera.
    return scaleVec(viewport.direction(frame.origin), -1);
  }

  // The factors of the scale on the three axes, by handle.
  private scaleFactors(handle: GizmoHandle, factor: number): Vec3 {
    if (handle === 'uniform') {
      return [factor, factor, factor];
    }
    const axis = handleAxis(handle) as number;
    const factors: Vec3 = isPlane(handle)
      ? [factor, factor, factor]
      : [1, 1, 1];
    factors[axis] = isPlane(handle) ? 1 : factor;
    return factors;
  }

  // Writes the local transforms of the targets from their new world
  // position and rotation (and their scale multiplied by `factors`).
  private apply(
    drag: Drag,
    world: (i: number) => { position: Vec3; rotation: Quat },
    factors?: Vec3,
  ): void {
    drag.targets.forEach((target, i) => {
      if (!isAlive(target)) {
        return;
      }
      const { position, rotation } = world(i);
      const parent = parentMatrix(target);
      const before = drag.before[i];
      const scale: Vec3 = factors
        ? [
            before.scale[0] * factors[0],
            before.scale[1] * factors[1],
            before.scale[2] * factors[2],
          ]
        : before.scale;
      writeTrs(transformOf(target), {
        ...toLocal(parent, position, rotation),
        scale,
      });
    });
    drag.moved = true;
  }
}

// --- Small vector helpers -----------------------------------------------------

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scaleVec = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const normalizeVec = (a: Vec3): Vec3 => scaleVec(a, 1 / (len(a) || 1));
const cross3 = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

// A ray in the space of the gizmo: origin at its center, its axes 1 long.
function toGizmo(
  frame: GizmoFrame,
  origin: Vec3,
  direction: Vec3,
): { origin: Vec3; direction: Vec3 } {
  const o = sub(origin, frame.origin);
  return {
    origin: frame.axes.map((a) => dot(o, a) / frame.scale) as Vec3,
    direction: toGizmoDirection(frame, direction),
  };
}

const toGizmoDirection = (frame: GizmoFrame, direction: Vec3): Vec3 =>
  frame.axes.map((a) => dot(direction, a)) as Vec3;

// The parameter, along a line (a point, a unit direction), of the point
// nearest to a ray.
function lineParameter(
  point: Vec3,
  axis: Vec3,
  origin: Vec3,
  direction: Vec3,
): number {
  const w = sub(point, origin);
  const b = dot(axis, direction);
  const d = 1 - b * b;
  if (d < 1e-6) {
    return 0;
  }
  return (b * dot(direction, w) - dot(axis, w)) / d;
}

// Where a ray crosses the plane through a point, of a unit normal.
function planePoint(
  point: Vec3,
  normal: Vec3,
  origin: Vec3,
  direction: Vec3,
): Vec3 | undefined {
  const t = rayPlane(origin, direction, point, normal);
  return t === undefined ? undefined : add(origin, scaleVec(direction, t));
}

// The local position and rotation under a parent of a world position and
// rotation.
function toLocal(
  parent: Matrix4 | undefined,
  position: Vec3,
  rotation: Quat,
): { position: Vec3; rotation: Quat } {
  if (!parent) {
    return { position, rotation };
  }
  const inverse = invert(parent);
  if (!inverse) {
    return { position, rotation };
  }
  return {
    position: transformPoint([0, 0, 0], inverse, position),
    rotation: normalizeQuat(
      multiplyQuat(conjugate(decompose(parent).rotation), rotation),
    ),
  };
}
