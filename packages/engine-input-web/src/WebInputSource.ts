import {
  createGamepadState,
  GamepadAxes,
  GamepadButtons,
  GamepadState,
  InputSink,
  InputSource,
} from '@fdw/engine-input';

// What the source reads of the navigator: navigator.getGamepads().
export interface GamepadProvider {
  getGamepads(): ArrayLike<Gamepad | null>;
}

export interface WebInputSourceOptions {
  /**
   * Where the gamepads come from: `navigator` by default. None where the
   * Gamepad API does not exist.
   */
  readonly gamepads?: GamepadProvider;
}

// A wheel notch: 100 pixels, or 3 lines, or a page.
const notchesOf = (event: WheelEvent) =>
  event.deltaMode === 1
    ? event.deltaY / 3
    : event.deltaMode === 2
    ? event.deltaY
    : event.deltaY / 100;

/**
 * The inputs of a page: the keyboard, the pointer and the wheel over an
 * element (a canvas: give it a `tabindex` to receive the keys once
 * clicked) or over the whole window, and the gamepads of the Gamepad API,
 * in the standard layout (the others are ignored: their buttons have no
 * known meaning).
 */
export class WebInputSource implements InputSource {
  private readonly _remove: (() => void)[] = [];
  private readonly _gamepads?: GamepadProvider;

  constructor(
    private readonly _target: HTMLElement | Window,
    options: WebInputSourceOptions = {}
  ) {
    this._gamepads =
      options.gamepads ??
      (typeof navigator !== 'undefined' && 'getGamepads' in navigator
        ? navigator
        : undefined);
  }

  attach(sink: InputSink): void {
    const target = this._target;
    const listen = <K extends keyof HTMLElementEventMap & keyof WindowEventMap>(
      type: K,
      listener: (event: HTMLElementEventMap[K]) => void,
      options?: AddEventListenerOptions
    ) => {
      const wrapped = listener as EventListener;
      target.addEventListener(type, wrapped, options);
      this._remove.push(() =>
        target.removeEventListener(type, wrapped, options)
      );
    };
    listen('keydown', (event) => sink.keyDown(event.code, event.key));
    listen('keyup', (event) => sink.keyUp(event.code, event.key));
    listen('pointermove', (event) => {
      if ('innerWidth' in target) {
        // Over the window.
        sink.pointerMove(
          event.clientX / Math.max(target.innerWidth, 1),
          event.clientY / Math.max(target.innerHeight, 1)
        );
      } else {
        // In the element, whose size is clientWidth × clientHeight.
        sink.pointerMove(
          event.offsetX / Math.max(target.clientWidth, 1),
          event.offsetY / Math.max(target.clientHeight, 1)
        );
      }
    });
    listen('pointerdown', (event) => sink.pointerButton(event.button, true));
    listen('pointerup', (event) => sink.pointerButton(event.button, false));
    listen('wheel', (event) => sink.wheel(notchesOf(event)), {
      passive: true,
    });
    listen('blur', () => sink.blur());
  }

  detach(): void {
    this._remove.forEach((remove) => remove());
    this._remove.length = 0;
  }

  readGamepads(out: GamepadState[]): number {
    const pads = this._gamepads?.getGamepads() ?? [];
    let count = 0;
    for (let i = 0; i < pads.length; i++) {
      const pad = pads[i];
      if (!pad || !pad.connected || pad.mapping !== 'standard') {
        continue;
      }
      const state = (out[count] ??= createGamepadState());
      // The index stays the same while the gamepad is connected.
      state.id = pad.index;
      state.name = pad.id;
      for (let b = 0; b < GamepadButtons.length; b++) {
        state.buttons[b] = pad.buttons[b]?.value ?? 0;
      }
      for (let a = 0; a < GamepadAxes.length; a++) {
        state.axes[a] = pad.axes[a] ?? 0;
      }
      count++;
    }
    return count;
  }
}
