import type { EngineMessage, InputCall } from '@fdw/editor-ui/protocol';
import {
  createGamepadState,
  GamepadState,
  InputSink,
  InputSource,
} from '@fdw/engine-input';

/**
 * The inputs of the page, in the engine process: the page reads the DOM
 * events of the viewport with a WebInputSource and sends the calls of its
 * sink, replayed here; its gamepads come at each animation frame. The
 * pointer lock and the rumbles go back to the page, which owns the
 * element and the gamepads.
 */
export class RemoteInputSource implements InputSource {
  private _sink?: InputSink;
  private _gamepads: readonly GamepadState[] = [];

  constructor(private readonly _post: (message: EngineMessage) => void) {}

  attach(sink: InputSink): void {
    this._sink = sink;
  }

  detach(): void {
    this._sink = undefined;
  }

  /** A call of the sink of the page. */
  receive(call: InputCall): void {
    const sink = this._sink;
    if (sink) {
      (sink[call.method] as (...args: unknown[]) => void)(...call.args);
    }
  }

  /** The gamepads of the page, as its last animation frame read them. */
  setGamepads(states: readonly GamepadState[]): void {
    this._gamepads = states;
  }

  readGamepads(out: GamepadState[]): number {
    this._gamepads.forEach((state, index) => {
      const target = (out[index] ??= createGamepadState());
      target.id = state.id;
      target.name = state.name;
      target.buttons.set(state.buttons);
      target.axes.set(state.axes);
    });
    return this._gamepads.length;
  }

  // The page tells the sink when the lock is taken or lost.
  setPointerLock(locked: boolean): void {
    this._post({ type: 'pointerLock', locked });
  }

  rumble(
    gamepad: number,
    strong: number,
    weak: number,
    duration: number,
  ): void {
    this._post({ type: 'rumble', gamepad, strong, weak, duration });
  }
}
