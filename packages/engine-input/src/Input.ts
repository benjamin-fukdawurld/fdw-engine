import {
  createGamepadState,
  GamepadAxes,
  GamepadAxis,
  GamepadButton,
  GamepadButtons,
  GamepadState,
  InputSink,
  InputSource,
} from './source';

/** The kinds of device: the one used last, see Input.lastDevice. */
export type InputDevice = 'keyboard' | 'pointer' | 'gamepad';

// Buttons or keys: those down now, and the presses and releases since the
// last update, then frozen for a frame.
class ButtonSet<K> {
  // As the events left them.
  private readonly _live = new Set<K>();
  private readonly _livePressed = new Set<K>();
  private readonly _liveReleased = new Set<K>();
  // The state of the frame.
  readonly down = new Set<K>();
  readonly pressed = new Set<K>();
  readonly released = new Set<K>();

  /** False for a repeat: the key was already down. */
  press(key: K): boolean {
    if (this._live.has(key)) {
      return false;
    }
    this._live.add(key);
    this._livePressed.add(key);
    return true;
  }

  release(key: K): void {
    if (this._live.delete(key)) {
      this._liveReleased.add(key);
    }
  }

  releaseAll(): void {
    for (const key of this._live) {
      this._liveReleased.add(key);
    }
    this._live.clear();
  }

  freeze(): void {
    copy(this._live, this.down);
    copy(this._livePressed, this.pressed);
    copy(this._liveReleased, this.released);
    this._livePressed.clear();
    this._liveReleased.clear();
  }
}

function copy<K>(from: Set<K>, to: Set<K>): void {
  to.clear();
  for (const key of from) {
    to.add(key);
  }
}

/** The keyboard, by physical key: `KeyW`, `ArrowUp`, `ShiftLeft`, `Space`. */
export class Keyboard {
  /** @internal */
  readonly _keys = new ButtonSet<string>();
  /** @internal */
  readonly _labels = new Map<string, string>();

  /** Whether the key is down during this frame. */
  isDown(code: string): boolean {
    return this._keys.down.has(code);
  }

  /**
   * Whether the key went down since the previous frame: once per press,
   * even released before the frame (then isDown is false).
   */
  pressed(code: string): boolean {
    return this._keys.pressed.has(code);
  }

  /** Whether the key was released since the previous frame. */
  released(code: string): boolean {
    return this._keys.released.has(code);
  }

  /**
   * What the key shows in the layout of the keyboard, once it was pressed
   * ("Z" for `KeyW` on an AZERTY keyboard), its code otherwise: to show it
   * to the user.
   */
  label(code: string): string {
    return this._labels.get(code) ?? code;
  }
}

/** The pointer: a mouse, a pen, a finger. */
export class Pointer {
  /** From 0 to 1 over the surface, from the top left corner. */
  x = 0.5;
  y = 0.5;
  /** Whether it moved since the previous frame. */
  moved = false;
  /** Whether it ever moved: before, x and y are the center. */
  seen = false;
  /**
   * How far it moved since the previous frame, in fractions of the
   * surface: x to the right, y downwards. 0 before its first move. Locked,
   * the pointer still moves by dx and dy, while x and y stay.
   */
  dx = 0;
  dy = 0;
  /** The wheel turned since the previous frame, in notches (positive: down). */
  wheel = 0;
  /**
   * Whether the pointer is locked (Input.lockPointer): hidden, it only
   * gives relative movements, without bounds.
   */
  locked = false;
  /** @internal: locked or released since the previous frame. */
  _lockChanged = false;
  /** @internal */
  readonly _buttons = new ButtonSet<number>();
  /** @internal */
  _live = {
    x: 0.5,
    y: 0.5,
    dx: 0,
    dy: 0,
    moved: false,
    seen: false,
    wheel: 0,
    locked: false,
  };

  isDown(button = 0): boolean {
    return this._buttons.down.has(button);
  }

  pressed(button = 0): boolean {
    return this._buttons.pressed.has(button);
  }

  released(button = 0): boolean {
    return this._buttons.released.has(button);
  }
}

/** The default dead zone of the sticks, a fraction of their range. */
export const DefaultDeadZone = 0.15;

// Down beyond half of the range: for the analog triggers.
const ButtonThreshold = 0.5;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** A gamepad, in the standard layout. */
export class Gamepad {
  /** The dead zone of the sticks, radial. */
  deadZone = DefaultDeadZone;
  /** @internal */
  readonly _state = createGamepadState();
  /** @internal */
  readonly _previous = new Float32Array(GamepadButtons.length);
  /** @internal: pressed or released between the frames. */
  readonly _pressed = new Uint8Array(GamepadButtons.length);
  readonly _released = new Uint8Array(GamepadButtons.length);

  /** @internal */
  constructor(private readonly _source?: InputSource) {}

  get id(): number {
    return this._state.id;
  }

  get name(): string {
    return this._state.name;
  }

  /** From 0 to 1: analog for the triggers. */
  value(button: GamepadButton): number {
    return this._state.buttons[GamepadButtons.indexOf(button)];
  }

  isDown(button: GamepadButton): boolean {
    return this.value(button) >= ButtonThreshold;
  }

  pressed(button: GamepadButton): boolean {
    return this._pressed[GamepadButtons.indexOf(button)] === 1;
  }

  released(button: GamepadButton): boolean {
    return this._released[GamepadButtons.indexOf(button)] === 1;
  }

  /** The raw value of an axis, from -1 to 1, without dead zone. */
  axis(axis: GamepadAxis): number {
    return this._state.axes[GamepadAxes.indexOf(axis)];
  }

  /**
   * A stick, with its radial dead zone: { x, y } of length 0 to 1, y
   * positive downwards. Within the dead zone, 0; beyond, rescaled from 0
   * to 1: no jump out of the zone, and the diagonals keep their direction.
   */
  stick(
    side: 'left' | 'right',
    out: { x: number; y: number } = { x: 0, y: 0 }
  ): { x: number; y: number } {
    const axes = this._state.axes;
    const x = side === 'left' ? axes[0] : axes[2];
    const y = side === 'left' ? axes[1] : axes[3];
    const length = Math.hypot(x, y);
    if (length <= this.deadZone) {
      out.x = 0;
      out.y = 0;
      return out;
    }
    const scaled =
      Math.min(1, (length - this.deadZone) / (1 - this.deadZone)) / length;
    out.x = x * scaled;
    out.y = y * scaled;
    return out;
  }

  /**
   * Shakes the gamepad: the strong (low frequency) and weak (high
   * frequency) motors from 0 to 1, for `duration` seconds. A new rumble
   * replaces the current one; rumble(0, 0, 0) stops. Nothing happens
   * without motors, or with a source that cannot drive them.
   */
  rumble(strong: number, weak: number, duration: number): void {
    this._source?.rumble?.(
      this.id,
      clamp01(strong),
      clamp01(weak),
      Math.max(0, duration)
    );
  }

  /** @internal: the new state of the frame, and its presses. */
  _update(state: GamepadState): boolean {
    const { buttons } = this._state;
    this._state.id = state.id;
    this._state.name = state.name;
    let used = false;
    for (let i = 0; i < buttons.length; i++) {
      const was = buttons[i] >= ButtonThreshold;
      buttons[i] = state.buttons[i] ?? 0;
      const is = buttons[i] >= ButtonThreshold;
      this._pressed[i] = is && !was ? 1 : 0;
      this._released[i] = was && !is ? 1 : 0;
      used ||= is;
    }
    this._state.axes.set(state.axes.subarray(0, this._state.axes.length));
    const probe = { x: 0, y: 0 };
    for (const side of ['left', 'right'] as const) {
      const { x, y } = this.stick(side, probe);
      used ||= x !== 0 || y !== 0;
    }
    return used;
  }
}

/**
 * The state of the keyboard, the pointer and the gamepads, read from a
 * source. Call update() once per frame, before the logic: it applies the
 * events received since the previous frame and polls the gamepads, then
 * the state stays the same for the whole frame.
 *
 * ```ts
 * const input = new Input(new WebInputSource(canvas));
 * // Every frame:
 * input.update();
 * if (input.keyboard.pressed('KeyF')) { … }
 * ```
 */
export class Input {
  readonly keyboard = new Keyboard();
  readonly pointer = new Pointer();
  /** The gamepads connected, in the order they were seen. */
  readonly gamepads: Gamepad[] = [];
  /** The device used last: to choose between aiming with the mouse or a stick. */
  lastDevice: InputDevice = 'keyboard';
  /** The number of update() calls: the frame of the state. */
  frame = 0;
  private _liveDevice: InputDevice = 'keyboard';
  private readonly _states: GamepadState[] = [];
  private readonly _byId = new Map<number, Gamepad>();

  constructor(private readonly _source: InputSource) {
    const { keyboard, pointer } = this;
    const sink: InputSink = {
      keyDown: (code, key) => {
        if (keyboard._keys.press(code)) {
          this._liveDevice = 'keyboard';
        }
        if (key.length > 0) {
          keyboard._labels.set(
            code,
            key.length === 1 ? key.toUpperCase() : key
          );
        }
      },
      keyUp: (code) => keyboard._keys.release(code),
      pointerMove: (x, y, dx, dy) => {
        const live = pointer._live;
        if (dx !== undefined && dy !== undefined) {
          live.dx += dx;
          live.dy += dy;
        } else if (live.seen) {
          // The first move comes from nowhere, not from the center.
          live.dx += x - live.x;
          live.dy += y - live.y;
        }
        live.x = x;
        live.y = y;
        live.moved = true;
        live.seen = true;
        this._liveDevice = 'pointer';
      },
      pointerLock: (locked) => {
        pointer._live.locked = locked;
      },
      pointerButton: (button, down) => {
        if (down) {
          pointer._buttons.press(button);
          this._liveDevice = 'pointer';
        } else {
          pointer._buttons.release(button);
        }
      },
      wheel: (notches) => {
        pointer._live.wheel += notches;
        this._liveDevice = 'pointer';
      },
      blur: () => {
        keyboard._keys.releaseAll();
        pointer._buttons.releaseAll();
      },
    };
    _source.attach(sink);
  }

  /** Applies the events since the previous frame, and polls the gamepads. */
  update(): void {
    const { keyboard, pointer } = this;
    keyboard._keys.freeze();
    pointer._buttons.freeze();
    const live = pointer._live;
    pointer.dx = live.dx;
    pointer.dy = live.dy;
    pointer.x = live.x;
    pointer.y = live.y;
    pointer.moved = live.moved;
    pointer.seen = live.seen;
    pointer.wheel = live.wheel;
    pointer._lockChanged = pointer.locked !== live.locked;
    pointer.locked = live.locked;
    live.dx = 0;
    live.dy = 0;
    live.moved = false;
    live.wheel = 0;
    this.lastDevice = this._liveDevice;
    this.frame++;
    this.updateGamepads();
  }

  /**
   * Locks the pointer — hidden, its movements relative and unbounded, for
   * a first person view — or releases it. Asynchronous: `pointer.locked`
   * tells when the source got it. A browser only locks it after a click or
   * a key of the user (call it in the frame of the press, or in its
   * handler), and releases it on Escape. Nothing happens with a source
   * that cannot lock it.
   */
  lockPointer(locked = true): void {
    this._source.setPointerLock?.(locked);
  }

  /** Stops listening to the source. */
  dispose(): void {
    this._source.detach();
  }

  private updateGamepads(): void {
    const count = this._source.readGamepads(this._states);
    const connected = new Set<number>();
    for (let i = 0; i < count; i++) {
      const state = this._states[i];
      connected.add(state.id);
      let gamepad = this._byId.get(state.id);
      if (!gamepad) {
        gamepad = new Gamepad(this._source);
        this._byId.set(state.id, gamepad);
        this.gamepads.push(gamepad);
      }
      if (gamepad._update(state)) {
        this.lastDevice = this._liveDevice = 'gamepad';
      }
    }
    // Disconnected: removed from the list.
    for (let i = this.gamepads.length - 1; i >= 0; i--) {
      const id = this.gamepads[i].id;
      if (!connected.has(id)) {
        this._byId.delete(id);
        this.gamepads.splice(i, 1);
      }
    }
  }
}
