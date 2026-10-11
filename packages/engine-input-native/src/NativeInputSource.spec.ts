import { Input } from '@fdw/engine-input';
import {
  NativeAddon,
  NativeWindow,
  RawWindowEvent,
  setAddon,
  WindowHandle,
} from '@fdw/engine-native';
import { afterEach, describe, expect, it } from 'vitest';
import { NativeInputSource } from './NativeInputSource';

// An addon with a window of 200 × 100 pixels, events queued by the test,
// and a gamepad (id 3) whose left stick is pushed up.
function fakeAddon(queue: RawWindowEvent[]): NativeAddon {
  return {
    init: () => undefined,
    quit: () => undefined,
    createWindow: () => ({} as WindowHandle),
    destroyWindow: () => undefined,
    windowId: () => 1,
    windowSize: () => [200, 100],
    setTitle: () => undefined,
    setVsync: () => undefined,
    presentRgba: () => undefined,
    pollEvents: () => queue.splice(0),
    nativeHandle: () => ({ system: 'x11', display: 0n, window: 0n }),
    gamepads: () => [3],
    gamepadState: (id, buttons, axes) => {
      buttons[7] = 0.9;
      axes[1] = -1;
      return 'SDL pad';
    },
  };
}

afterEach(() => setAddon(undefined));

describe('NativeInputSource', () => {
  it('reads the keys, the pointer, the wheel and the gamepads', () => {
    const queue: RawWindowEvent[] = [];
    setAddon(fakeAddon(queue));
    const window = new NativeWindow();
    const input = new Input(new NativeInputSource(window));
    queue.push(
      { type: 'keydown', window: 1, key: 'Z', code: 'KeyW' },
      { type: 'pointermove', window: 1, x: 50, y: 25 },
      { type: 'pointerdown', window: 1, button: 0 },
      { type: 'wheel', window: 1, dy: 2 }
    );
    NativeWindow.pollEvents();
    input.update();
    expect(input.keyboard.isDown('KeyW')).toBe(true);
    expect(input.keyboard.label('KeyW')).toBe('Z');
    expect([input.pointer.x, input.pointer.y]).toEqual([0.25, 0.25]);
    expect(input.pointer.isDown(0)).toBe(true);
    // Two steps up: two notches up.
    expect(input.pointer.wheel).toBe(-2);
    const [gamepad] = input.gamepads;
    expect(gamepad.name).toBe('SDL pad');
    expect(gamepad.isDown('rightTrigger')).toBe(true);
    expect(gamepad.stick('left')).toEqual({ x: 0, y: -1 });
    input.dispose();
    window.destroy();
  });
});
