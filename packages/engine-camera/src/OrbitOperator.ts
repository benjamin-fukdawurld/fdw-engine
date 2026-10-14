import type { ActionDefinition, ActionMap } from '@fdw/engine-input';
import {
  CameraTarget,
  clamp,
  forwardOf,
  MaxPitch,
  rightOf,
  rotationOf,
  upOf,
  Vec3Like,
  viewOf,
} from './target';

/** What an OrbitOperator reads: the names of its actions. */
export type OrbitIntent =
  | 'move'
  | 'orbit'
  | 'zoom'
  | 'zoomStep'
  | 'orbitDrag'
  | 'panDrag'
  | 'pointer';

/**
 * The default actions of an OrbitOperator: WASD (ZQSD on AZERTY) and the
 * left stick move the pivot over the ground, the arrows and the right stick
 * turn around it, as the pointer dragged with its main button; the pointer
 * dragged with its secondary or middle button pans; the wheel, Q and E or
 * the triggers zoom.
 */
export const OrbitActions: Readonly<Record<OrbitIntent, ActionDefinition>> = {
  move: {
    type: 'vector',
    bindings: [
      { up: 'key:KeyW', down: 'key:KeyS', left: 'key:KeyA', right: 'key:KeyD' },
      'gamepad:leftStick',
    ],
  },
  orbit: {
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
  // Positive: further away.
  zoom: {
    type: 'axis',
    bindings: [
      { negative: 'key:KeyE', positive: 'key:KeyQ' },
      { negative: 'gamepad:rightTrigger', positive: 'gamepad:leftTrigger' },
    ],
  },
  zoomStep: { type: 'axis', bindings: ['pointer:wheel'] },
  orbitDrag: { type: 'button', bindings: ['pointer:0'] },
  panDrag: { type: 'button', bindings: ['pointer:2', 'pointer:1'] },
  pointer: { type: 'vector', bindings: ['pointer:delta'] },
};

export interface OrbitOperatorOptions {
  /** What the camera turns around. Default: the origin. */
  readonly pivot?: Readonly<Vec3Like>;
  /** How far from the pivot. Default 10. */
  readonly distance?: number;
  /** Around the pivot, in radians: 0 looks along -z, positive turns left. */
  readonly yaw?: number;
  /** In radians: negative looks down at the pivot, from above. Default -0.4. */
  readonly pitch?: number;
  /** The limits of the distance. Default 0.5 and 1000. */
  readonly minDistance?: number;
  readonly maxDistance?: number;
  /** The limits of the pitch. Default ±89°. */
  readonly minPitch?: number;
  readonly maxPitch?: number;
  /** Radians per second, the stick or the keys pushed fully. Default 2. */
  readonly orbitSpeed?: number;
  /** Radians per height of the surface dragged. Default 3. */
  readonly pointerSpeed?: number;
  /** Distances per second the pivot moves. Default 1. */
  readonly moveSpeed?: number;
  /** The zoom held: the distance multiplied by e per second. Default 1. */
  readonly zoomSpeed?: number;
  /** A notch of the wheel: the distance multiplied by e^0.1. Default 0.1. */
  readonly zoomStep?: number;
  /** Up turns down, for the stick, the keys and the pointer. */
  readonly invertY?: boolean;
  /** The names of the actions in the ActionMap, when not the intents. */
  readonly names?: Partial<Record<OrbitIntent, string>>;
}

/**
 * Turns around a pivot, as in a modeling tool or a strategy game: the right
 * stick or the pointer dragged turns, the left stick moves the pivot over
 * the ground, the pointer dragged with the secondary button pans, the
 * wheel and the triggers zoom.
 *
 * ```ts
 * const actions = new ActionMap(input, OrbitActions);
 * const orbit = new OrbitOperator(camera, actions, { distance: 12 });
 * // Every frame, after input.update():
 * orbit.update(dt);
 * ```
 */
export class OrbitOperator {
  readonly pivot: Vec3Like;
  distance: number;
  yaw: number;
  pitch: number;
  minDistance: number;
  maxDistance: number;
  minPitch: number;
  maxPitch: number;
  orbitSpeed: number;
  pointerSpeed: number;
  moveSpeed: number;
  zoomSpeed: number;
  zoomStep: number;
  invertY: boolean;
  /** Disabled, update() does nothing. */
  enabled = true;
  private readonly _names: Record<OrbitIntent, string>;
  private readonly _vector = { x: 0, y: 0 };
  private readonly _pointer = { x: 0, y: 0 };
  private readonly _forward = { x: 0, y: 0, z: 0 };
  private readonly _right = { x: 0, y: 0, z: 0 };
  private readonly _up = { x: 0, y: 0, z: 0 };

  constructor(
    private readonly _target: CameraTarget,
    private readonly _actions: ActionMap,
    options: OrbitOperatorOptions = {}
  ) {
    this.pivot = { x: 0, y: 0, z: 0, ...options.pivot };
    this.distance = options.distance ?? 10;
    this.yaw = options.yaw ?? 0;
    this.pitch = options.pitch ?? -0.4;
    this.minDistance = options.minDistance ?? 0.5;
    this.maxDistance = options.maxDistance ?? 1000;
    this.minPitch = options.minPitch ?? -MaxPitch;
    this.maxPitch = options.maxPitch ?? MaxPitch;
    this.orbitSpeed = options.orbitSpeed ?? 2;
    this.pointerSpeed = options.pointerSpeed ?? 3;
    this.moveSpeed = options.moveSpeed ?? 1;
    this.zoomSpeed = options.zoomSpeed ?? 1;
    this.zoomStep = options.zoomStep ?? 0.1;
    this.invertY = options.invertY ?? false;
    this._names = {
      move: 'move',
      orbit: 'orbit',
      zoom: 'zoom',
      zoomStep: 'zoomStep',
      orbitDrag: 'orbitDrag',
      panDrag: 'panDrag',
      pointer: 'pointer',
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
    const { fov, aspect } = viewOf(this._target);

    // Turning: to the right, the view turns right (the camera goes left
    // around the pivot); up, it looks up (the camera goes down).
    const orbit = actions.vector(names.orbit, this._vector);
    let yaw = -orbit.x * this.orbitSpeed * dt;
    let pitch = orbit.y * flip * this.orbitSpeed * dt;
    const pointer = actions.vector(names.pointer, this._pointer);
    if (actions.button(names.orbitDrag).down) {
      yaw -= pointer.x * aspect * this.pointerSpeed;
      pitch += pointer.y * flip * this.pointerSpeed;
    }
    this.yaw += yaw;
    this.pitch = clamp(this.pitch + pitch, this.minPitch, this.maxPitch);

    const pivot = this.pivot;
    const right = rightOf(this.yaw, this._right);
    if (actions.button(names.panDrag).down) {
      // The pivot follows the pointer: the height of the view at the pivot.
      const height = 2 * this.distance * Math.tan(fov / 2);
      const up = upOf(this.yaw, this.pitch, this._up);
      const x = pointer.x * aspect * height;
      const y = pointer.y * height;
      pivot.x -= right.x * x + up.x * y;
      pivot.y -= right.y * x + up.y * y;
      pivot.z -= right.z * x + up.z * y;
    }

    // Over the ground, whatever the pitch, faster when far.
    const move = actions.vector(names.move, this._vector);
    const step = this.moveSpeed * this.distance * dt;
    const ahead = forwardOf(this.yaw, 0, this._forward);
    pivot.x += (ahead.x * move.y + right.x * move.x) * step;
    pivot.z += (ahead.z * move.y + right.z * move.x) * step;

    const zoom =
      actions.axis(names.zoom) * this.zoomSpeed * dt +
      actions.axis(names.zoomStep) * this.zoomStep;
    this.distance = clamp(
      this.distance * Math.exp(zoom),
      this.minDistance,
      this.maxDistance
    );
    this.apply();
  }

  /** Where the camera is: back from the pivot, along its view. */
  get position(): Vec3Like {
    const forward = forwardOf(this.yaw, this.pitch, this._forward);
    return {
      x: this.pivot.x - forward.x * this.distance,
      y: this.pivot.y - forward.y * this.distance,
      z: this.pivot.z - forward.z * this.distance,
    };
  }

  /** Writes the position and the rotation into the target. */
  apply(): void {
    this._target.position = this.position;
    this._target.rotation = rotationOf(this.yaw, this.pitch);
  }
}
