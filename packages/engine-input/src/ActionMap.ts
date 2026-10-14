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

  constructor(
    private readonly _input: Input,
    definitions: Readonly<Record<string, ActionDefinition>>,
    private readonly _options: ActionMapOptions = {}
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
    out: { x: number; y: number } = { x: 0, y: 0 }
  ): { x: number; y: number } {
    const definition = this.definition(name, 'vector');
    let bestX = 0;
    let bestY = 0;
    let best = 0;
    const stick = { x: 0, y: 0 };
    const bindings = this.active
      ? (definition.bindings as readonly VectorBinding[])
      : [];
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
    type?: ActionDefinition['type']
  ): ActionDefinition {
    const definition = this._definitions.get(name);
    if (!definition) {
      throw new Error(`No action "${name}"`);
    }
    if (type && definition.type !== type) {
      throw new Error(
        `The action "${name}" is a ${definition.type}, not a ${type}`
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
    return gamepads[index] ? [gamepads[index]] : [];
  }

  private readButton(control: Control): ButtonState {
    const [device, name] = split(control);
    const { keyboard, pointer } = this._input;
    if (control === 'pointer:locked') {
      const changed = pointer._lockChanged;
      return {
        down: pointer.locked,
        pressed: pointer.locked && changed,
        released: !pointer.locked && changed,
        value: pointer.locked ? 1 : 0,
      };
    }
    if (device === 'key') {
      const down = keyboard.isDown(name);
      return {
        down,
        pressed: keyboard.pressed(name),
        released: keyboard.released(name),
        value: down ? 1 : 0,
      };
    }
    if (device === 'pointer') {
      const button = Number(name);
      const down = pointer.isDown(button);
      return {
        down,
        pressed: pointer.pressed(button),
        released: pointer.released(button),
        value: down ? 1 : 0,
      };
    }
    if (device === 'gamepad' && isButton(name)) {
      let state = NotPressed;
      for (const gamepad of this.gamepads()) {
        const value = gamepad.value(name);
        if (value > state.value || gamepad.pressed(name)) {
          state = {
            down: gamepad.isDown(name),
            pressed: gamepad.pressed(name) || state.pressed,
            released: gamepad.released(name),
            value: Math.max(value, state.value),
          };
        }
      }
      return state;
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
      const stick = { x: 0, y: 0 };
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
    const stick = { x: 0, y: 0 };
    for (const gamepad of this.gamepads()) {
      gamepad.stick(side, stick);
      if (Math.hypot(stick.x, stick.y) > Math.hypot(out.x, out.y)) {
        out.x = stick.x;
        out.y = stick.y;
      }
    }
  }
}

function split(control: Control): [string, string] {
  const colon = control.indexOf(':');
  if (colon < 0) {
    throw new Error(`Not a control: "${control}" (device:name)`);
  }
  return [control.slice(0, colon), control.slice(colon + 1)];
}

const isButton = (name: string): name is (typeof GamepadButtons)[number] =>
  (GamepadButtons as readonly string[]).includes(name);

const isAxis = (name: string): name is (typeof GamepadAxes)[number] =>
  (GamepadAxes as readonly string[]).includes(name);
