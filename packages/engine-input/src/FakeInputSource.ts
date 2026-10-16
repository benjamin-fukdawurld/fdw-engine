import {
  createGamepadState,
  GamepadAxis,
  GamepadAxes,
  GamepadButton,
  GamepadButtons,
  GamepadState,
  InputSink,
  InputSource,
} from './source';

/**
 * A source driven by code: for the tests of an application, or to replay
 * inputs. The events go to the Input at once; the gamepads are read at its
 * next update().
 */
export class FakeInputSource implements InputSource {
  /** The Input listening, once attached. */
  sink?: InputSink;
  /** The gamepads connected: change their buttons and axes freely. */
  readonly gamepads: GamepadState[] = [];
  /** Whether the pointer is locked: setPointerLock() takes it at once. */
  pointerLocked = false;
  /** The rumbles asked, in order. */
  readonly rumbles: {
    gamepad: number;
    strong: number;
    weak: number;
    duration: number;
  }[] = [];
  private _nextId = 0;

  attach(sink: InputSink): void {
    this.sink = sink;
  }

  detach(): void {
    this.sink = undefined;
  }

  readGamepads(out: GamepadState[]): number {
    this.gamepads.forEach((state, i) => {
      out[i] ??= createGamepadState();
      out[i].id = state.id;
      out[i].name = state.name;
      out[i].buttons.set(state.buttons);
      out[i].axes.set(state.axes);
    });
    return this.gamepads.length;
  }

  setPointerLock(locked: boolean): void {
    this.pointerLocked = locked;
    this.sink?.pointerLock(locked);
  }

  rumble(
    gamepad: number,
    strong: number,
    weak: number,
    duration: number,
  ): void {
    this.rumbles.push({ gamepad, strong, weak, duration });
  }

  /** Presses a key (`code`, and what it produces: its `key`). */
  keyDown(code: string, key = ''): void {
    this.sink?.keyDown(code, key);
  }

  keyUp(code: string, key = ''): void {
    this.sink?.keyUp(code, key);
  }

  /** Connects a gamepad: returns its state. */
  connectGamepad(name = 'Fake gamepad'): GamepadState {
    const state = createGamepadState();
    state.id = this._nextId++;
    state.name = name;
    this.gamepads.push(state);
    return state;
  }

  disconnectGamepad(state: GamepadState): void {
    this.gamepads.splice(this.gamepads.indexOf(state), 1);
  }

  /** Sets a button of a gamepad, from 0 to 1. */
  setButton(state: GamepadState, button: GamepadButton, value: number): void {
    state.buttons[GamepadButtons.indexOf(button)] = value;
  }

  /** Sets an axis of a gamepad, from -1 to 1. */
  setAxis(state: GamepadState, axis: GamepadAxis, value: number): void {
    state.axes[GamepadAxes.indexOf(axis)] = value;
  }
}
