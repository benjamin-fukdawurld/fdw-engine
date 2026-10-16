/**
 * The buttons of a gamepad in the standard layout: the same in the browser
 * (the Gamepad API, `mapping: 'standard'`) and with SDL3 (`SDL_Gamepad`).
 * `south`, `east`, `west` and `north` are A, B, X and Y on an Xbox
 * controller, cross, circle, square and triangle on a PlayStation one. In
 * the order of the standard mapping of the Gamepad API.
 */
export const GamepadButtons = [
  'south',
  'east',
  'west',
  'north',
  'leftShoulder',
  'rightShoulder',
  'leftTrigger',
  'rightTrigger',
  'back',
  'start',
  'leftStick',
  'rightStick',
  'dpadUp',
  'dpadDown',
  'dpadLeft',
  'dpadRight',
  'guide',
] as const;
export type GamepadButton = (typeof GamepadButtons)[number];

/**
 * The axes of the sticks, from -1 to 1: x positive to the right, y
 * positive downwards (as in the Gamepad API and SDL).
 */
export const GamepadAxes = ['leftX', 'leftY', 'rightX', 'rightY'] as const;
export type GamepadAxis = (typeof GamepadAxes)[number];

/** The state of a gamepad, as a source reads it. */
export interface GamepadState {
  // Stable while the gamepad stays connected.
  id: number;
  name: string;
  // From 0 to 1, in the order of GamepadButtons: analog for the triggers.
  readonly buttons: Float32Array;
  // From -1 to 1, in the order of GamepadAxes.
  readonly axes: Float32Array;
}

/** A new GamepadState, every button released, the sticks at rest. */
export function createGamepadState(): GamepadState {
  return {
    id: -1,
    name: '',
    buttons: new Float32Array(GamepadButtons.length),
    axes: new Float32Array(GamepadAxes.length),
  };
}

/**
 * What a source writes the events into: given by Input. Positions are
 * normalized; keys are given by their physical position (`code`, as the
 * `code` of the DOM: `KeyW`, `ArrowUp`, `ShiftLeft`) and by what they
 * produce in the layout of the keyboard (`key`: "z" for `KeyW` on an
 * AZERTY keyboard).
 */
export interface InputSink {
  keyDown(code: string, key: string): void;
  keyUp(code: string, key: string): void;
  /**
   * From 0 to 1 over the surface, from the top left corner. `dx` and `dy`:
   * the relative movement, in fractions of the surface, when the source
   * knows it (the only movement while the pointer is locked: the position
   * stays); without them, the difference of the positions.
   */
  pointerMove(x: number, y: number, dx?: number, dy?: number): void;
  /** The pointer was locked or released (see InputSource.setPointerLock). */
  pointerLock(locked: boolean): void;
  /** Buttons as in the DOM: 0 main, 1 middle, 2 secondary. */
  pointerButton(button: number, down: boolean): void;
  /** In notches, positive downwards. */
  wheel(notches: number): void;
  /** The focus was lost: every key and button is released. */
  blur(): void;
}

/**
 * Where the events come from: the DOM of a page (engine-input-web), a
 * native window (engine-input-native), or a test.
 */
export interface InputSource {
  /** Starts writing the events into `sink`. */
  attach(sink: InputSink): void;
  /**
   * The states of the gamepads connected, written into `out` (grown when
   * needed, its objects reused): returns how many there are. Gamepads are
   * polled, not received as events: the browser requires it.
   */
  readGamepads(out: GamepadState[]): number;
  /** Stops writing the events. */
  detach(): void;
  /**
   * Locks the pointer — hidden, its movements relative and unbounded, for
   * a first person view — or releases it. The source tells the sink when
   * the lock is taken or lost: a browser may refuse it, and releases it on
   * Escape. Optional: without it, the pointer is never locked.
   */
  setPointerLock?(locked: boolean): void;
  /**
   * Shakes a gamepad (its `id`): the strong (low frequency) and weak (high
   * frequency) motors from 0 to 1, for `duration` seconds; 0 stops. A new
   * rumble replaces the previous one. Optional, and ignored by a gamepad
   * without motors.
   */
  rumble?(
    gamepad: number,
    strong: number,
    weak: number,
    duration: number,
  ): void;
}
