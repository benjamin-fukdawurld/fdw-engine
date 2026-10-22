import type { GamepadState, InputSink } from '@fdw/engine-input';

// The messages between the page and the engine process, over the
// MessagePort the main process gives them (see src/main/engine.ts).

/** The bounds of the viewport in the window, in device pixels. */
export interface ViewportBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A call of the InputSink of the page (a WebInputSource), replayed by the engine. */
export type InputCall = {
  [K in keyof InputSink]: {
    readonly method: K;
    readonly args: Parameters<InputSink[K]>;
  };
}[keyof InputSink];

/** From the page to the engine. */
export type PageMessage =
  // An empty area hides the viewport.
  | ({ readonly type: 'bounds' } & ViewportBounds)
  | { readonly type: 'scene'; readonly name: string }
  | ({ readonly type: 'input' } & InputCall)
  // At each animation frame while gamepads are connected (then once empty).
  | { readonly type: 'gamepads'; readonly states: readonly GamepadState[] };

/** From the engine to the page. */
export type EngineMessage =
  | {
      readonly type: 'ready';
      readonly device: string;
      readonly scenes: readonly string[];
      readonly scene: string;
    }
  // Once a second.
  | {
      readonly type: 'stats';
      readonly fps: number;
      readonly width: number;
      readonly height: number;
      readonly info: string;
    }
  | { readonly type: 'loading'; readonly scene: string }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'pointerLock'; readonly locked: boolean }
  | {
      readonly type: 'rumble';
      readonly gamepad: number;
      readonly strong: number;
      readonly weak: number;
      readonly duration: number;
    };

/** From the main process to the engine process (process.parentPort). */
export type ControlMessage =
  // The XID of the Electron window, in decimal.
  | { readonly type: 'init'; readonly parent: string }
  // With a new port to the page (one per page load).
  | { readonly type: 'connect' }
  // The window was minimized or hidden, or comes back.
  | { readonly type: 'visible'; readonly visible: boolean }
  | { readonly type: 'quit' };
