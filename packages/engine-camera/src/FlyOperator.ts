import type { ActionDefinition, ActionMap } from '@fdw/engine-input';
import {
  CameraTarget,
  clamp,
  forwardOf,
  MaxPitch,
  rightOf,
  rotationOf,
  Vec3Like,
  viewOf,
} from './target';

/** What a FlyOperator reads: the names of its actions. */
export type FlyIntent = 'move' | 'lift' | 'look' | 'drag' | 'pointer' | 'run';

/**
 * The default actions of a FlyOperator: give them to an ActionMap, rebind
 * them, save them. WASD (ZQSD on AZERTY) and the left stick move, Q and E
 * or the triggers go down and up, the arrows and the right stick look
 * around, as the pointer dragged with its main or secondary button, or
 * moved while it is locked (Input.lockPointer); Shift or the left stick
 * pressed runs.
 */
export const FlyActions: Readonly<Record<FlyIntent, ActionDefinition>> = {
  move: {
    type: 'vector',
    bindings: [
      { up: 'key:KeyW', down: 'key:KeyS', left: 'key:KeyA', right: 'key:KeyD' },
      'gamepad:leftStick',
    ],
  },
  lift: {
    type: 'axis',
    bindings: [
      { negative: 'key:KeyQ', positive: 'key:KeyE' },
      { negative: 'gamepad:leftTrigger', positive: 'gamepad:rightTrigger' },
    ],
  },
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
  drag: {
    type: 'button',
    bindings: ['pointer:0', 'pointer:2', 'pointer:locked'],
  },
  pointer: { type: 'vector', bindings: ['pointer:delta'] },
  run: {
    type: 'button',
    bindings: ['key:ShiftLeft', 'key:ShiftRight', 'gamepad:leftStick'],
  },
};

export interface FlyOperatorOptions {
  /** Where the camera starts. Default: the origin. */
  readonly position?: Readonly<Vec3Like>;
  /** Its heading, in radians around y: 0 looks along -z, positive turns left. */
  readonly yaw?: number;
  /** Its pitch, in radians: positive looks up. */
  readonly pitch?: number;
  /**
   * `fly` (default) moves where the camera looks; `walk` stays
   * horizontal, as in a first person game: only `lift` goes up and down.
   */
  readonly mode?: 'fly' | 'walk';
  /** In units per second. Default 5. */
  readonly speed?: number;
  /** The speed multiplied while `run` is held. Default 3. */
  readonly runFactor?: number;
  /** Radians per second, the stick or the keys pushed fully. Default 2.5. */
  readonly lookSpeed?: number;
  /** Radians per height of the surface dragged. Default 3. */
  readonly pointerSpeed?: number;
  /** Up looks down, for the stick, the keys and the pointer. */
  readonly invertY?: boolean;
  /** The limits of the pitch. Default ±89°. */
  readonly minPitch?: number;
  readonly maxPitch?: number;
  /**
   * The names of the actions in the ActionMap, when they are not the
   * intents: to share an ActionMap with the rest of an application.
   */
  readonly names?: Partial<Record<FlyIntent, string>>;
}

/**
 * Free navigation, flying or walking: moves where the camera looks (the
 * left stick, WASD), turns it (the right stick, the arrows, the pointer
 * dragged). Reads named actions, so that every control can be rebound:
 *
 * ```ts
 * const actions = new ActionMap(input, FlyActions);
 * const fly = new FlyOperator(camera, actions, { position: { x: 0, y: 2, z: 8 } });
 * // Every frame, after input.update():
 * fly.update(dt);
 * ```
 */
export class FlyOperator {
  readonly position: Vec3Like;
  yaw: number;
  pitch: number;
  mode: 'fly' | 'walk';
  speed: number;
  runFactor: number;
  lookSpeed: number;
  pointerSpeed: number;
  invertY: boolean;
  minPitch: number;
  maxPitch: number;
  /** Disabled, update() does nothing: a menu is open, another operator drives. */
  enabled = true;
  private readonly _names: Record<FlyIntent, string>;
  private readonly _vector = { x: 0, y: 0 };
  private readonly _forward = { x: 0, y: 0, z: 0 };
  private readonly _right = { x: 0, y: 0, z: 0 };

  constructor(
    private readonly _target: CameraTarget,
    private readonly _actions: ActionMap,
    options: FlyOperatorOptions = {}
  ) {
    this.position = { x: 0, y: 0, z: 0, ...options.position };
    this.yaw = options.yaw ?? 0;
    this.pitch = options.pitch ?? 0;
    this.mode = options.mode ?? 'fly';
    this.speed = options.speed ?? 5;
    this.runFactor = options.runFactor ?? 3;
    this.lookSpeed = options.lookSpeed ?? 2.5;
    this.pointerSpeed = options.pointerSpeed ?? 3;
    this.invertY = options.invertY ?? false;
    this.minPitch = options.minPitch ?? -MaxPitch;
    this.maxPitch = options.maxPitch ?? MaxPitch;
    this._names = {
      move: 'move',
      lift: 'lift',
      look: 'look',
      drag: 'drag',
      pointer: 'pointer',
      run: 'run',
      ...options.names,
    };
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

    // Turning first: the move goes where the camera now looks.
    const look = actions.vector(names.look, this._vector);
    let yaw = -look.x * this.lookSpeed * dt;
    let pitch = look.y * flip * this.lookSpeed * dt;
    if (actions.button(names.drag).down) {
      const { aspect } = viewOf(this._target);
      const pointer = actions.vector(names.pointer, this._vector);
      // To the right: look to the right; the width is aspect heights.
      yaw -= pointer.x * aspect * this.pointerSpeed;
      pitch += pointer.y * flip * this.pointerSpeed;
    }
    this.yaw += yaw;
    this.pitch = clamp(this.pitch + pitch, this.minPitch, this.maxPitch);

    const speed =
      this.speed * (actions.button(names.run).down ? this.runFactor : 1) * dt;
    const move = actions.vector(names.move, this._vector);
    const forward = forwardOf(
      this.yaw,
      this.mode === 'walk' ? 0 : this.pitch,
      this._forward
    );
    const right = rightOf(this.yaw, this._right);
    const lift = actions.axis(names.lift);
    const position = this.position;
    position.x += (forward.x * move.y + right.x * move.x) * speed;
    position.y += (forward.y * move.y + lift) * speed;
    position.z += (forward.z * move.y + right.z * move.x) * speed;
    this.apply();
  }

  /** Turns the camera towards a point. */
  lookAt(point: Readonly<Vec3Like>): void {
    const dx = point.x - this.position.x;
    const dy = point.y - this.position.y;
    const dz = point.z - this.position.z;
    this.yaw = Math.atan2(-dx, -dz);
    this.pitch = clamp(
      Math.atan2(dy, Math.hypot(dx, dz)),
      this.minPitch,
      this.maxPitch
    );
    this.apply();
  }

  /** Writes the position and the rotation into the target. */
  apply(): void {
    // A copy: the target may keep the object.
    this._target.position = { ...this.position };
    this._target.rotation = rotationOf(this.yaw, this.pitch);
  }
}
