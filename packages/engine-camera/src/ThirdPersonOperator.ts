import type { ActionDefinition, ActionMap } from '@fdw/engine-input';
import {
  CameraTarget,
  clamp,
  forwardOf,
  rightOf,
  rotationOf,
  Vec3Like,
  viewOf,
} from './target';

/** What a ThirdPersonOperator reads: the names of its actions. */
export type ThirdPersonIntent = 'look' | 'drag' | 'pointer' | 'zoomStep';

/**
 * The default actions of a ThirdPersonOperator: the arrows and the right
 * stick turn the camera, as the pointer moved while locked or dragged with
 * the secondary button; the wheel brings it closer or further.
 */
export const ThirdPersonActions: Readonly<
  Record<ThirdPersonIntent, ActionDefinition>
> = {
  look: {
    type: 'vector',
    bindings: [
      {
        up: 'key:ArrowUp',
        down: 'key:ArrowDown',
        left: 'key:ArrowLeft',
        right: 'key:ArrowRight',
      },
      'gamepad:rightStick',
    ],
  },
  drag: { type: 'button', bindings: ['pointer:locked', 'pointer:2'] },
  pointer: { type: 'vector', bindings: ['pointer:delta'] },
  zoomStep: { type: 'axis', bindings: ['pointer:wheel'] },
};

/**
 * How far the camera can go from the pivot towards `to` before hitting
 * something, for a sphere of `radius` moving from `from`: the distance
 * travelled, or undefined when nothing is in the way. Implemented by the
 * application, with its physics (a shape cast) or its scene.
 */
export type CameraProbe = (
  from: Readonly<Vec3Like>,
  to: Readonly<Vec3Like>,
  radius: number,
) => number | undefined;

export interface ThirdPersonOperatorOptions {
  /** The point followed (the feet of a character). Default: the origin. */
  readonly focus?: Readonly<Vec3Like>;
  /** The pivot, above the focus (the head). Default 1.6. */
  readonly height?: number;
  /** How far behind the pivot. Default 4. */
  readonly distance?: number;
  /** The limits of the distance (the wheel). Default 1.5 and 10. */
  readonly minDistance?: number;
  readonly maxDistance?: number;
  /** To the right of the pivot (over the shoulder); negative: the left. Default 0.5. */
  readonly shoulder?: number;
  /** In radians: 0 looks along -z, positive turns left. */
  readonly yaw?: number;
  /** In radians: negative looks down. Default -0.25. */
  readonly pitch?: number;
  /** The limits of the pitch. Default -70° and 45°. */
  readonly minPitch?: number;
  readonly maxPitch?: number;
  /** Radians per second, the stick or the keys pushed fully. Default 2.5. */
  readonly lookSpeed?: number;
  /** Radians per height of the surface the pointer moves. Default 3. */
  readonly pointerSpeed?: number;
  /** A notch of the wheel: the distance multiplied by e^0.1. Default 0.1. */
  readonly zoomStep?: number;
  /**
   * Seconds for the pivot to cover half of its way to the focus: it
   * follows smoothly, not rigidly. 0: rigidly. Default 0.06.
   */
  readonly followHalfLife?: number;
  /**
   * Seconds for the arm, shortened by an obstacle, to cover half of its
   * way back. It shortens at once. Default 0.25.
   */
  readonly returnHalfLife?: number;
  /** What stops the camera from going through walls. Default: nothing. */
  readonly probe?: CameraProbe;
  /** The radius of the camera for the probe. Default 0.25. */
  readonly radius?: number;
  /** Up turns down, for the stick, the keys and the pointer. */
  readonly invertY?: boolean;
  /** The names of the actions in the ActionMap, when not the intents. */
  readonly names?: Partial<Record<ThirdPersonIntent, string>>;
}

// The share of the way left after dt, for a half-life: 2^(-dt / halfLife).
const left = (dt: number, halfLife: number) =>
  halfLife > 0 ? Math.pow(2, -dt / halfLife) : 0;

/**
 * Follows a character from behind, over its shoulder, as in a third-person
 * game: the pointer (locked) or the right stick turns around it, the wheel
 * brings the camera closer. The pivot follows the focus with a damped
 * spring; an arm from the pivot places the camera, shortened at once by
 * what the probe hits (a wall, a tree), back to its length smoothly.
 *
 * The camera looks where the character goes: `forward` and `right` (on
 * the ground) move it relative to the view.
 *
 * ```ts
 * const actions = new ActionMap(input, ThirdPersonActions);
 * const camera3p = new ThirdPersonOperator(camera, actions, {
 *   probe: (from, to, radius) => world.shapeCast(...)?.distance,
 * });
 * // Every frame, after the character moved:
 * camera3p.focus = character.position;
 * camera3p.update(dt);
 * ```
 */
export class ThirdPersonOperator {
  /** The point followed: set it at each frame. */
  focus: Vec3Like;
  height: number;
  distance: number;
  minDistance: number;
  maxDistance: number;
  shoulder: number;
  yaw: number;
  pitch: number;
  minPitch: number;
  maxPitch: number;
  lookSpeed: number;
  pointerSpeed: number;
  zoomStep: number;
  followHalfLife: number;
  returnHalfLife: number;
  probe: CameraProbe | undefined;
  radius: number;
  invertY: boolean;
  /** Disabled, update() does nothing. */
  enabled = true;
  /** The pivot, following the focus. */
  readonly pivot: Vec3Like;
  private _arm: number;
  private readonly _names: Record<ThirdPersonIntent, string>;
  private readonly _vector = { x: 0, y: 0 };
  private readonly _pointer = { x: 0, y: 0 };
  private readonly _forward = { x: 0, y: 0, z: 0 };
  private readonly _right = { x: 0, y: 0, z: 0 };

  constructor(
    private readonly _target: CameraTarget,
    private readonly _actions: ActionMap,
    options: ThirdPersonOperatorOptions = {},
  ) {
    this.focus = { x: 0, y: 0, z: 0, ...options.focus };
    this.height = options.height ?? 1.6;
    this.distance = options.distance ?? 4;
    this.minDistance = options.minDistance ?? 1.5;
    this.maxDistance = options.maxDistance ?? 10;
    this.shoulder = options.shoulder ?? 0.5;
    this.yaw = options.yaw ?? 0;
    this.pitch = options.pitch ?? -0.25;
    this.minPitch = options.minPitch ?? (-70 * Math.PI) / 180;
    this.maxPitch = options.maxPitch ?? (45 * Math.PI) / 180;
    this.lookSpeed = options.lookSpeed ?? 2.5;
    this.pointerSpeed = options.pointerSpeed ?? 3;
    this.zoomStep = options.zoomStep ?? 0.1;
    this.followHalfLife = options.followHalfLife ?? 0.06;
    this.returnHalfLife = options.returnHalfLife ?? 0.25;
    this.probe = options.probe;
    this.radius = options.radius ?? 0.25;
    this.invertY = options.invertY ?? false;
    this._names = {
      look: 'look',
      drag: 'drag',
      pointer: 'pointer',
      zoomStep: 'zoomStep',
      ...options.names,
    };
    this.pivot = { x: 0, y: 0, z: 0 };
    this._arm = this.distance;
    this.snap();
  }

  /** The length of the arm now: the distance, or less behind an obstacle. */
  get arm(): number {
    return this._arm;
  }

  /** Where the view looks, on the ground: where "forward" moves a character. */
  get forward(): Vec3Like {
    return forwardOf(this.yaw, 0, { x: 0, y: 0, z: 0 });
  }

  /** The right of the view, on the ground. */
  get right(): Vec3Like {
    return rightOf(this.yaw, { x: 0, y: 0, z: 0 });
  }

  /**
   * Puts the pivot on the focus at once, the arm at its length: after a
   * teleport, without a camera flying across the level.
   */
  snap(): void {
    this.pivot.x = this.focus.x;
    this.pivot.y = this.focus.y + this.height;
    this.pivot.z = this.focus.z;
    this._arm = this.allowed();
    this.apply();
  }

  /** Reads the actions of the frame, then moves the target: dt in seconds. */
  update(dt: number): void {
    if (!this.enabled) {
      return;
    }
    const actions = this._actions;
    const names = this._names;
    const flip = this.invertY ? -1 : 1;
    const { aspect } = viewOf(this._target);

    // Right turns the view right, up looks up.
    const look = actions.vector(names.look, this._vector);
    let yaw = -look.x * this.lookSpeed * dt;
    let pitch = look.y * flip * this.lookSpeed * dt;
    if (actions.button(names.drag).down) {
      const pointer = actions.vector(names.pointer, this._pointer);
      yaw -= pointer.x * aspect * this.pointerSpeed;
      pitch += pointer.y * flip * this.pointerSpeed;
    }
    this.yaw += yaw;
    this.pitch = clamp(this.pitch + pitch, this.minPitch, this.maxPitch);
    this.distance = clamp(
      this.distance * Math.exp(actions.axis(names.zoomStep) * this.zoomStep),
      this.minDistance,
      this.maxDistance,
    );

    // The pivot follows the focus, damped.
    const k = left(dt, this.followHalfLife);
    const pivot = this.pivot;
    pivot.x = this.focus.x + (pivot.x - this.focus.x) * k;
    pivot.y =
      this.focus.y + this.height + (pivot.y - this.focus.y - this.height) * k;
    pivot.z = this.focus.z + (pivot.z - this.focus.z) * k;

    // The arm: shortened at once, lengthened back smoothly.
    const allowed = this.allowed();
    this._arm =
      allowed < this._arm
        ? allowed
        : allowed + (this._arm - allowed) * left(dt, this.returnHalfLife);
    this.apply();
  }

  /** Where the camera is: behind the pivot, over the shoulder. */
  get position(): Vec3Like {
    return this.along(this._arm);
  }

  /** Writes the position and the rotation into the target. */
  apply(): void {
    this._target.position = this.position;
    this._target.rotation = rotationOf(this.yaw, this.pitch);
  }

  // The point of the arm at `length` from the pivot: the shoulder offset
  // shrinks with the arm, so that a short arm stays behind the head.
  private along(length: number): Vec3Like {
    const forward = forwardOf(this.yaw, this.pitch, this._forward);
    const right = rightOf(this.yaw, this._right);
    const side =
      this.distance > 0 ? (this.shoulder * length) / this.distance : 0;
    return {
      x: this.pivot.x - forward.x * length + right.x * side,
      y: this.pivot.y - forward.y * length + right.y * side,
      z: this.pivot.z - forward.z * length + right.z * side,
    };
  }

  // The length the probe allows for the arm.
  private allowed(): number {
    if (!this.probe) {
      return this.distance;
    }
    const to = this.along(this.distance);
    const hit = this.probe(this.pivot, to, this.radius);
    if (hit === undefined) {
      return this.distance;
    }
    // The probe measures along the arm, shoulder included.
    const full = Math.hypot(
      to.x - this.pivot.x,
      to.y - this.pivot.y,
      to.z - this.pivot.z,
    );
    return full > 0 ? clamp((hit / full) * this.distance, 0, this.distance) : 0;
  }
}
