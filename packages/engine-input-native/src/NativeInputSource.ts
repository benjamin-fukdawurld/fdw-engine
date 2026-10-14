import {
  createGamepadState,
  GamepadState,
  InputSink,
  InputSource,
} from '@fdw/engine-input';
import { NativeWindow, NativeWindowEvent } from '@fdw/engine-native';

/**
 * The inputs of a native window: its keyboard, pointer and wheel events,
 * and the gamepads of SDL3, in the standard layout. The pointer locks in
 * the relative mode of SDL; the gamepads rumble with SDL_RumbleGamepad. The events are read by
 * NativeWindow.pollEvents() (runLoop calls it): a gamepad connected shows
 * at the next frame.
 */
export class NativeInputSource implements InputSource {
  private readonly _remove: (() => void)[] = [];
  private _sink?: InputSink;

  constructor(private readonly _window: NativeWindow) {}

  attach(sink: InputSink): void {
    const window = this._window;
    const listen = (
      type: string,
      listener: (event: NativeWindowEvent) => void
    ) => {
      const wrapped = (event: Event) => listener(event as NativeWindowEvent);
      window.addEventListener(type, wrapped);
      this._remove.push(() => window.removeEventListener(type, wrapped));
    };
    // The key name of SDL ("Z", "Left Shift") stands for the DOM `key`.
    listen('keydown', (event) => sink.keyDown(event.code, event.key));
    listen('keyup', (event) => sink.keyUp(event.code, event.key));
    // SDL gives the movement too: the only one while the pointer is locked.
    listen('pointermove', (event) => {
      const width = Math.max(window.width, 1);
      const height = Math.max(window.height, 1);
      sink.pointerMove(
        event.x / width,
        event.y / height,
        event.dx / width,
        event.dy / height
      );
    });
    listen('pointerdown', (event) => sink.pointerButton(event.button, true));
    listen('pointerup', (event) => sink.pointerButton(event.button, false));
    // SDL: steps, positive upwards.
    listen('wheel', (event) => sink.wheel(-event.dy));
    listen('blur', () => sink.blur());
    this._sink = sink;
  }

  setPointerLock(locked: boolean): void {
    this._window.pointerLocked = locked;
    this._sink?.pointerLock(locked);
  }

  rumble(
    gamepad: number,
    strong: number,
    weak: number,
    duration: number
  ): void {
    NativeWindow.rumbleGamepad(gamepad, strong, weak, duration);
  }

  detach(): void {
    this._remove.forEach((remove) => remove());
    this._remove.length = 0;
    this._sink = undefined;
  }

  readGamepads(out: GamepadState[]): number {
    let count = 0;
    for (const id of NativeWindow.gamepads()) {
      const state = (out[count] ??= createGamepadState());
      const name = NativeWindow.readGamepad(id, state.buttons, state.axes);
      if (name === undefined) {
        continue;
      }
      state.id = id;
      state.name = name;
      count++;
    }
    return count;
  }
}
