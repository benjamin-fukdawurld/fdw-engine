import { NativeWindow } from './NativeWindow';

export interface RunLoopOptions {
  /**
   * Called after each frame: the next one starts when it resolves. A
   * surface presenting with a delay (DawnWindowSurface.throttle) keeps the
   * frames in flight bounded with it.
   */
  readonly throttle?: () => Promise<void>;
}

export interface RunningLoop {
  stop(): void;
  // Resolves when the loop stops; rejects with the error of a frame.
  readonly done: Promise<void>;
}

/**
 * The render loop outside of the browser, in place of
 * requestAnimationFrame: dispatches the window events, calls `frame` with
 * the time in milliseconds (as performance.now()), waits for the throttle,
 * and lets the Node event loop run (promises, I/O) between frames.
 */
export function runLoop(
  frame: (time: number) => void | Promise<void>,
  { throttle }: RunLoopOptions = {},
): RunningLoop {
  let running = true;
  const yieldToNode = () =>
    new Promise<void>((resolve) => setImmediate(resolve));
  const done = (async () => {
    while (running) {
      NativeWindow.pollEvents();
      if (!running) {
        break;
      }
      await frame(performance.now());
      await throttle?.();
      await yieldToNode();
    }
  })();
  return {
    stop: () => {
      running = false;
    },
    done,
  };
}
