import type { Gamepad, Input } from './Input';
import { GamepadAxes, GamepadButtons } from './source';

/**
 * A control, as a string: it saves, compares and shows as it is.
 *
 * - `key:<code>`: a key, by physical position (`key:KeyW`);
 * - `pointer:<button>`: a button of the pointer (`pointer:0`), and
 *   `pointer:wheel`, the wheel (an axis: notches of the frame);
 * - `pointer:delta`: the movement of the pointer during the frame, for a
 *   vector, in fractions of the surface; `pointer:deltaX`,
 *   `pointer:deltaY`: the same, as axes (y positive downwards);
 * - `pointer:locked`: a button, down while the pointer is locked;
 * - `gamepad:<button>`: a button of a gamepad (`gamepad:south`,
 *   `gamepad:rightTrigger`);
 * - `gamepad:<axis>`: an axis of a stick, from -1 to 1 (`gamepad:leftX`);
 * - `gamepad:leftStick`, `gamepad:rightStick`: a stick, for a vector.
 */
export type Control = string;

/** Two controls pulling an axis each way. */
export interface AxisPair {
  readonly negative: Control;
  readonly positive: Control;
}

/** Four controls making a vector, or a stick. */
export interface VectorQuad {
  readonly up: Control;
  readonly down: Control;
  readonly left: Control;
  readonly right: Control;
}

export type ButtonBinding = Control;
export type AxisBinding = Control | AxisPair;
export type VectorBinding = Control | VectorQuad;

export type ActionDefinition =
  | { readonly type: 'button'; readonly bindings: readonly ButtonBinding[] }
  | { readonly type: 'axis'; readonly bindings: readonly AxisBinding[] }
  | { readonly type: 'vector'; readonly bindings: readonly VectorBinding[] };

/** The bindings of every action, by name: what toJSON() saves. */
export type Bindings = Readonly<Record<string, readonly (Control | object)[]>>;

/** The state of a button action during a frame. */
export interface ButtonState {
  /** Held during this frame. */
  readonly down: boolean;
  /** Went down since the previous frame: once per press. */
  readonly pressed: boolean;
  /** Was released since the previous frame. */
  readonly released: boolean;
  /** From 0 to 1: analog for a trigger. */
  readonly value: number;
}

export interface ActionMapOptions {
  /**
   * The gamepad of these actions: an index in input.gamepads, for a game
   * where each player has one. Default: every gamepad, the strongest wins.
   */
  readonly gamepad?: number;
  /** Saved bindings (toJSON()), replacing those of the definitions. */
  readonly bindings?: Bindings;
  /** Whether the actions are read: see ActionMap.enabled. Default true. */
  readonly enabled?: boolean;
}

const NotPressed: ButtonState = {
  down: false,
  pressed: false,
  released: false,
  value: 0,
};

// What readButton() gives, reused: read at once, never kept.
interface ButtonRead {
  down: boolean;
  pressed: boolean;
  released: boolean;
  value: number;
}

/**
 * Named actions, bound to controls: the code of an application reads
 * `move` or `jump`, not `KeyW` or `leftX`, and the user can change the
 * bindings. Several bindings per action: the strongest wins (the keyboard
 * and a stick do not add up).
 *
 * ```ts
 * const actions = new ActionMap(input, {
 *   jump: { type: 'button', bindings: ['key:Space', 'gamepad:south'] },
 *   move: {
 *     type: 'vector',
 *     bindings: [
 *       { up: 'key:KeyW', down: 'key:KeyS', left: 'key:KeyA', right: 'key:KeyD' },
 *       'gamepad:leftStick',
 *     ],
 *   },
 * });
 * if (actions.button('jump').pressed) { … }
 * const { x, y } = actions.vector('move'); // y forward
 * ```
 *
 * A context — a menu, the game — is an ActionMap of its own, enabled while
 * it is active: a disabled map reads nothing.
 */
export class ActionMap {
  private readonly _definitions = new Map<string, ActionDefinition>();
  private _enabled: boolean;
  // The frame of the input when the map was enabled.
  private _enabledFrame = -1;
  // Scratch values of the reads, reused: an action read allocates nothing
  // (but the state of a button pressed, which it returns).
  private readonly _read: ButtonRead = { ...NotPressed };
  private readonly _stick = { x: 0, y: 0 };
  private readonly _vectorStick = { x: 0, y: 0 };
  private readonly _oneGamepad: Gamepad[] = [];

  constructor(
    private readonly _input: Input,
    definitions: Readonly<Record<string, ActionDefinition>>,
    private readonly _options: ActionMapOptions = {},
  ) {
    for (const [name, definition] of Object.entries(definitions)) {
      this._definitions.set(name, definition);
    }
    for (const [name, bindings] of Object.entries(_options.bindings ?? {})) {
      this.rebind(name, bindings as ActionDefinition['bindings']);
    }
    this._enabled = _options.enabled ?? true;
  }

  /**
   * Whether the actions are read. Disabled, every button is released, every
   * axis and vector 0: the actions of a context that is not active (the
   * game under a menu). Enabled during a frame, the map reads nothing
   * until the next input.update(): the press that opened a menu does not
   * also act in it.
   */
  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(enabled: boolean) {
    if (enabled && !this._enabled) {
      this._enabledFrame = this._input.frame;
    }
    this._enabled = enabled;
  }

  /** Whether the actions are read during this frame. */
  get active(): boolean {
    return this._enabled && this._enabledFrame !== this._input.frame;
  }

  /**
   * Shakes the gamepads of these actions (see Gamepad.rumble): the strong
   * and weak motors from 0 to 1, for `duration` seconds.
   */
  rumble(strong: number, weak: number, duration: number): void {
    for (const gamepad of this.gamepads()) {
      gamepad.rumble(strong, weak, duration);
    }
  }

  /** The bindings of every action. */
  get bindings(): Bindings {
    return this.toJSON();
  }

  /** Replaces the bindings of an action. */
  rebind(name: string, bindings: ActionDefinition['bindings']): void {
    const definition = this.definition(name);
    this._definitions.set(name, {
      type: definition.type,
      bindings,
    } as ActionDefinition);
  }

  /** The bindings, to save: give them back as the `bindings` option. */
  toJSON(): Bindings {
    const result: Record<string, readonly (Control | object)[]> = {};
    for (const [name, { bindings }] of this._definitions) {
      result[name] = bindings;
    }
    return result;
  }

  /** A button action: held, pressed, released during this frame. */
  button(name: string): ButtonState {
    const definition = this.definition(name, 'button');
    let state = NotPressed;
    if (!this.active) {
      return state;
    }
    let down = false;
    let pressed = false;
    let released = false;
    let value = 0;
    for (const control of definition.bindings as readonly Control[]) {
      const read = this.readButton(control);
      down ||= read.down;
      pressed ||= read.pressed;
      released ||= read.released;
      value = Math.max(value, read.value);
    }
    if (down || pressed || released) {
      // Released by one control, still held by another: not released.
      state = { down, pressed, released: released && !down, value };
    }
    return state;
  }

  /** An axis action: the strongest of its bindings. */
  axis(name: string): number {
    const definition = this.definition(name, 'axis');
    let result = 0;
    if (!this.active) {
      return result;
    }
    for (const binding of definition.bindings as readonly AxisBinding[]) {
      const value =
        typeof binding === 'string'
          ? this.readAxis(binding)
          : this.readButton(binding.positive).value -
            this.readButton(binding.negative).value;
      if (Math.abs(value) > Math.abs(result)) {
        result = value;
      }
    }
    return result;
  }

  /**
   * A vector action: { x, y } of length 0 to 1, x to the right, y up (or
   * forward). Four keys are normalized: the diagonal is not faster.
   */
  vector(
    name: string,
    out: { x: number; y: number } = { x: 0, y: 0 },
  ): { x: number; y: number } {
    const definition = this.definition(name, 'vector');
    let bestX = 0;
    let bestY = 0;
    let best = 0;
    const stick = this._vectorStick;
    const bindings = this.active
      ? (definition.bindings as readonly VectorBinding[])
      : NoBindings;
    for (const binding of bindings) {
      let x: number;
      let y: number;
      if (typeof binding === 'string') {
        this.readStick(binding, stick);
        x = stick.x;
        // The stick is positive downwards: up here.
        y = 0 - stick.y; // 0, not -0, at rest
      } else {
        x =
          this.readButton(binding.right).value -
          this.readButton(binding.left).value;
        y =
          this.readButton(binding.up).value -
          this.readButton(binding.down).value;
        const length = Math.hypot(x, y);
        if (length > 1) {
          x /= length;
          y /= length;
        }
      }
      const length = Math.hypot(x, y);
      if (length > best) {
        best = length;
        bestX = x;
        bestY = y;
      }
    }
    out.x = bestX;
    out.y = bestY;
    return out;
  }

  private definition(
    name: string,
    type?: ActionDefinition['type'],
  ): ActionDefinition {
    const definition = this._definitions.get(name);
    if (!definition) {
      throw new Error(`No action "${name}"`);
    }
    if (type && definition.type !== type) {
      throw new Error(
        `The action "${name}" is a ${definition.type}, not a ${type}`,
      );
    }
    return definition;
  }

  // The gamepads of these actions.
  private gamepads(): readonly Gamepad[] {
    const { gamepads } = this._input;
    const index = this._options.gamepad;
    if (index === undefined) {
      return gamepads;
    }
    const one = this._oneGamepad;
    one.length = 0;
    if (gamepads[index]) {
      one.push(gamepads[index]);
    }
    return one;
  }

  // The state of a control, in a scratch value: read it before the next.
  private readButton(control: Control): ButtonState {
    const [device, name] = split(control);
    const { keyboard, pointer } = this._input;
    const read = this._read;
    if (control === 'pointer:locked') {
      const changed = pointer._lockChanged;
      read.down = pointer.locked;
      read.pressed = pointer.locked && changed;
      read.released = !pointer.locked && changed;
      read.value = pointer.locked ? 1 : 0;
      return read;
    }
    if (device === 'key') {
      read.down = keyboard.isDown(name);
      read.pressed = keyboard.pressed(name);
      read.released = keyboard.released(name);
      read.value = read.down ? 1 : 0;
      return read;
    }
    if (device === 'pointer') {
      const button = Number(name);
      read.down = pointer.isDown(button);
      read.pressed = pointer.pressed(button);
      read.released = pointer.released(button);
      read.value = read.down ? 1 : 0;
      return read;
    }
    if (device === 'gamepad' && isButton(name)) {
      read.down = false;
      read.pressed = false;
      read.released = false;
      read.value = 0;
      for (const gamepad of this.gamepads()) {
        const value = gamepad.value(name);
        if (value > read.value || gamepad.pressed(name)) {
          read.down = gamepad.isDown(name);
          read.pressed = gamepad.pressed(name) || read.pressed;
          read.released = gamepad.released(name);
          read.value = Math.max(value, read.value);
        }
      }
      return read;
    }
    throw new Error(`Not a button: "${control}"`);
  }

  private readAxis(control: Control): number {
    const [device, name] = split(control);
    const { pointer } = this._input;
    if (control === 'pointer:wheel') {
      return pointer.wheel;
    }
    if (control === 'pointer:deltaX') {
      return pointer.dx;
    }
    if (control === 'pointer:deltaY') {
      return pointer.dy;
    }
    if (device === 'gamepad' && isAxis(name)) {
      let result = 0;
      const stick = this._stick;
      for (const gamepad of this.gamepads()) {
        // Through the dead zone of its stick.
        gamepad.stick(name.startsWith('left') ? 'left' : 'right', stick);
        const value = name.endsWith('X') ? stick.x : stick.y;
        if (Math.abs(value) > Math.abs(result)) {
          result = value;
        }
      }
      return result;
    }
    // A button as an axis: 0 or 1, or the value of a trigger.
    return this.readButton(control).value;
  }

  private readStick(control: Control, out: { x: number; y: number }): void {
    out.x = 0;
    out.y = 0;
    if (control === 'pointer:delta') {
      // Not a stick, but read as one: y positive downwards.
      out.x = this._input.pointer.dx;
      out.y = this._input.pointer.dy;
      return;
    }
    const side =
      control === 'gamepad:leftStick'
        ? 'left'
        : control === 'gamepad:rightStick'
          ? 'right'
          : undefined;
    if (!side) {
      throw new Error(`Not a stick: "${control}"`);
    }
    const stick = this._stick;
    for (const gamepad of this.gamepads()) {
      gamepad.stick(side, stick);
      if (Math.hypot(stick.x, stick.y) > Math.hypot(out.x, out.y)) {
        out.x = stick.x;
        out.y = stick.y;
      }
    }
  }
}

const NoBindings: readonly VectorBinding[] = [];

// The device and the name of each control, split once: the controls are
// the few of the bindings, read every frame.
const splits = new Map<Control, readonly [string, string]>();

function split(control: Control): readonly [string, string] {
  let parts = splits.get(control);
  if (parts) {
    return parts;
  }
  const colon = control.indexOf(':');
  if (colon < 0) {
    throw new Error(`Not a control: "${control}" (device:name)`);
  }
  parts = [control.slice(0, colon), control.slice(colon + 1)];
  splits.set(control, parts);
  return parts;
}

const isButton = (name: string): name is (typeof GamepadButtons)[number] =>
  (GamepadButtons as readonly string[]).includes(name);

const isAxis = (name: string): name is (typeof GamepadAxes)[number] =>
  (GamepadAxes as readonly string[]).includes(name);
