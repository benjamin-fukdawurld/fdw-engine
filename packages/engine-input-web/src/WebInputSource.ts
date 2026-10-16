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
 * known meaning). The pointer locks to the element (the Pointer Lock API,
 * the root element for the window); the gamepads rumble through their
 * `vibrationActuator`, where the browser has it.
 */
export class WebInputSource implements InputSource {
  private readonly _remove: (() => void)[] = [];
  private readonly _gamepads?: GamepadProvider;
  // The element the pointer locks to, and its document.
  private readonly _lockElement?: Element;
  private readonly _document?: Document;
  // Whether a move was seen since the pointer got locked.
  private _movedLocked = false;

  constructor(
    private readonly _target: HTMLElement | Window,
    options: WebInputSourceOptions = {},
  ) {
    this._gamepads =
      options.gamepads ??
      (typeof navigator !== 'undefined' && 'getGamepads' in navigator
        ? navigator
        : undefined);
    this._document =
      'document' in _target ? _target.document : _target.ownerDocument;
    this._lockElement =
      'document' in _target ? this._document?.documentElement : _target;
  }

  // Whether the pointer is locked to the element.
  private get locked(): boolean {
    return (
      this._lockElement !== undefined &&
      this._document?.pointerLockElement === this._lockElement
    );
  }

  attach(sink: InputSink): void {
    const target = this._target;
    const listen = <K extends keyof HTMLElementEventMap & keyof WindowEventMap>(
      type: K,
      listener: (event: HTMLElementEventMap[K]) => void,
      options?: AddEventListenerOptions,
    ) => {
      const wrapped = listener as EventListener;
      target.addEventListener(type, wrapped, options);
      this._remove.push(() =>
        target.removeEventListener(type, wrapped, options),
      );
    };
    listen('keydown', (event) => sink.keyDown(event.code, event.key));
    listen('keyup', (event) => sink.keyUp(event.code, event.key));
    listen('pointermove', (event) => {
      // Over the window, or in the element, of clientWidth × clientHeight.
      const overWindow = 'innerWidth' in target;
      const width = Math.max(
        overWindow ? target.innerWidth : target.clientWidth,
        1,
      );
      const height = Math.max(
        overWindow ? target.innerHeight : target.clientHeight,
        1,
      );
      const x = (overWindow ? event.clientX : event.offsetX) / width;
      const y = (overWindow ? event.clientY : event.offsetY) / height;
      if (!this.locked) {
        this._movedLocked = false;
        sink.pointerMove(x, y);
      } else if (!this._movedLocked) {
        // The first move once locked: Chromium gives it a movement from
        // nowhere (up to the size of the screen).
        this._movedLocked = true;
        sink.pointerMove(x, y, 0, 0);
      } else {
        // The position stays: only the movement counts.
        sink.pointerMove(
          x,
          y,
          event.movementX / width,
          event.movementY / height,
        );
      }
    });
    listen('pointerdown', (event) => sink.pointerButton(event.button, true));
    listen('pointerup', (event) => sink.pointerButton(event.button, false));
    listen('wheel', (event) => sink.wheel(notchesOf(event)), {
      passive: true,
    });
    listen('blur', () => sink.blur());
    const document = this._document;
    if (document) {
      const changed = () => sink.pointerLock(this.locked);
      document.addEventListener('pointerlockchange', changed);
      this._remove.push(() =>
        document.removeEventListener('pointerlockchange', changed),
      );
    }
  }

  setPointerLock(locked: boolean): void {
    const element = this._lockElement;
    if (!element || locked === this.locked) {
      return;
    }
    if (locked) {
      // Refused without a recent gesture of the user: pointer.locked
      // stays false. A promise in recent browsers, nothing in older ones.
      const request = element.requestPointerLock?.() as unknown;
      if (request instanceof Promise) {
        request.catch(() => undefined);
      }
    } else {
      this._document?.exitPointerLock?.();
    }
  }

  rumble(
    gamepad: number,
    strong: number,
    weak: number,
    duration: number,
  ): void {
    const pad = this._gamepads?.getGamepads()[gamepad];
    const actuator = pad?.vibrationActuator;
    if (!actuator) {
      return;
    }
    const done =
      duration <= 0 || (strong <= 0 && weak <= 0)
        ? actuator.reset?.()
        : actuator.playEffect?.('dual-rumble', {
            duration: duration * 1000,
            strongMagnitude: strong,
            weakMagnitude: weak,
          });
    // Rejected when a new rumble replaces it.
    (done as Promise<unknown> | undefined)?.catch?.(() => undefined);
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
