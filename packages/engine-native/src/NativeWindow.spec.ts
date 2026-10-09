import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Modifiers,
  NativeAddon,
  RawWindowEvent,
  setAddon,
  WindowFlags,
  WindowHandle,
} from './addon';
import { NativeWindow, NativeWindowEvent } from './NativeWindow';
import { runLoop } from './runLoop';

// An addon recording the calls, with events queued by the test.
function fakeAddon() {
  const calls: string[] = [];
  const queue: RawWindowEvent[] = [];
  let next = 1;
  const addon: NativeAddon = {
    init: () => calls.push('init'),
    quit: () => calls.push('quit'),
    createWindow: (title, width, height, flags) => {
      calls.push(`create ${title} ${width}×${height} ${flags}`);
      return { id: next++, width, height } as unknown as WindowHandle;
    },
    destroyWindow: () => calls.push('destroy'),
    windowId: (window) => (window as unknown as { id: number }).id,
    windowSize: (window) => {
      const { width, height } = window as unknown as {
        width: number;
        height: number;
      };
      // A display of density 2.
      return [width * 2, height * 2];
    },
    setTitle: (_, title) => calls.push(`title ${title}`),
    setVsync: (_, vsync) => calls.push(`vsync ${vsync}`),
    presentRgba: (_, pixels, width, height, stride) =>
      calls.push(`present ${pixels.length} ${width}×${height} ${stride}`),
    pollEvents: () => queue.splice(0),
  };
  return { addon, calls, queue };
}

afterEach(() => setAddon(undefined));

describe('NativeWindow', () => {
  it('initializes the native library while windows are open', () => {
    const { addon, calls } = fakeAddon();
    setAddon(addon);
    const first = new NativeWindow({ title: 'a', width: 100, height: 50 });
    const second = new NativeWindow({ hidden: true, resizable: false });
    expect(first.width).toBe(200);
    expect(first.height).toBe(100);
    first.destroy();
    first.destroy();
    second.destroy();
    expect(calls).toEqual([
      'init',
      `create a 100×50 ${WindowFlags.resizable}`,
      `create FdwEngine 1280×720 ${WindowFlags.hidden}`,
      'destroy',
      'destroy',
      'quit',
    ]);
    expect(() => (first.title = 'closed')).toThrow(/destroyed/);
  });

  it('dispatches the events to their window', () => {
    const { addon, queue } = fakeAddon();
    setAddon(addon);
    const left = new NativeWindow();
    const right = new NativeWindow();
    const received: string[] = [];
    for (const window of [left, right]) {
      for (const type of ['resize', 'keydown', 'pointerdown', 'close']) {
        window.addEventListener(type, (event) => {
          const e = event as NativeWindowEvent;
          received.push(
            `${window === left ? 'left' : 'right'} ${e.type} ${e.key}${
              e.ctrlKey ? ' ctrl' : ''
            } ${e.x},${e.y} ${e.button}`
          );
        });
      }
    }
    queue.push(
      { type: 'resize', window: right.id, width: 640, height: 480 },
      {
        type: 'keydown',
        window: left.id,
        key: 'Escape',
        modifiers: Modifiers.ctrl,
      },
      { type: 'pointerdown', window: left.id, x: 10, y: 20, button: 2 },
      { type: 'close', window: 99 }
    );
    NativeWindow.pollEvents();
    expect(received).toEqual([
      'right resize  0,0 0',
      'left keydown Escape ctrl 0,0 0',
      'left pointerdown  10,20 2',
    ]);
    // The size follows the window.
    expect([right.width, right.height]).toEqual([640, 480]);
    left.destroy();
    right.destroy();
  });

  it('presents images with their stride', () => {
    const { addon, calls } = fakeAddon();
    setAddon(addon);
    const window = new NativeWindow();
    window.presentRgba(new Uint8Array(16), 2, 2);
    window.presentRgba(new Uint8Array(512), 2, 2, 256);
    window.vsync = false;
    expect(calls.slice(-3)).toEqual([
      'present 16 2×2 8',
      'present 512 2×2 256',
      'vsync 0',
    ]);
    window.destroy();
  });
});

describe('runLoop', () => {
  it('runs frames until stopped, after each throttle', async () => {
    const { addon, queue } = fakeAddon();
    setAddon(addon);
    const window = new NativeWindow();
    const events: string[] = [];
    let frames = 0;
    const loop = runLoop(
      () => {
        events.push(`frame ${++frames}`);
        if (frames === 2) {
          queue.push({ type: 'close', window: window.id });
        }
      },
      {
        throttle: async () => {
          events.push('throttle');
        },
      }
    );
    // The events of a frame are dispatched before the next one.
    window.addEventListener('close', () => {
      events.push('close');
      loop.stop();
    });
    await loop.done;
    expect(events).toEqual([
      'frame 1',
      'throttle',
      'frame 2',
      'throttle',
      'close',
    ]);
    window.destroy();
  });

  it('stops on the error of a frame', async () => {
    const loop = runLoop(() => {
      throw new Error('broken frame');
    });
    await expect(loop.done).rejects.toThrow('broken frame');
  });
});

// The real addon, when it is built and a display is available.
const built = existsSync(new URL('../build/fdw_native.node', import.meta.url));
const display = !!(process.env['DISPLAY'] || process.env['WAYLAND_DISPLAY']);

describe.skipIf(!built || !display)('NativeWindow (SDL3)', () => {
  it('creates, presents to and destroys a window', () => {
    const window = new NativeWindow({
      title: 'test',
      width: 64,
      height: 32,
      hidden: true,
    });
    expect(window.width).toBeGreaterThanOrEqual(64);
    expect(window.height).toBeGreaterThanOrEqual(32);
    window.vsync = false;
    const pixels = new Uint8Array(256 * 32).fill(128);
    window.presentRgba(pixels, 64, 32, 256);
    expect(() => window.presentRgba(new Uint8Array(4), 64, 32)).toThrow(
      RangeError
    );
    NativeWindow.pollEvents();
    window.destroy();
    expect(window.destroyed).toBe(true);
  });
});
