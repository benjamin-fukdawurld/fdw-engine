import { Input } from '@fdw/engine-input';
import {
  NativeAddon,
  NativeAudioAddon,
  NativeWindow,
  RawWindowEvent,
  setAddon,
  WindowHandle,
} from '@fdw/engine-native';
import { afterEach, describe, expect, it } from 'vitest';
import { NativeInputSource } from './NativeInputSource';

// An addon with a window of 200 × 100 pixels, events queued by the test,
// and a gamepad (id 3) whose left stick is pushed up; without the audio.
function fakeAddon(queue: RawWindowEvent[], calls: string[] = []): NativeAddon {
  const addon: Omit<NativeAddon, keyof NativeAudioAddon> = {
    init: () => undefined,
    quit: () => undefined,
    createWindow: () => ({}) as WindowHandle,
    destroyWindow: () => undefined,
    windowId: () => 1,
    windowSize: () => [200, 100],
    setTitle: () => undefined,
    setVsync: () => undefined,
    setRelativeMouse: (_, enabled) => calls.push(`relative ${enabled}`),
    presentRgba: () => undefined,
    pollEvents: () => queue.splice(0),
    nativeHandle: () => ({ system: 'x11', display: 0n, window: 0n }),
    gamepads: () => [3],
    gamepadState: (id, buttons, axes) => {
      buttons[7] = 0.9;
      axes[1] = -1;
      return 'SDL pad';
    },
    gamepadRumble: (id, strong, weak, ms) =>
      calls.push(`rumble ${id} ${strong} ${weak} ${ms}`) > 0,
    decodeImage: (_) =>
      Promise.resolve({
        width: 1,
        height: 1,
        channels: 4,
        hdr: true,
        pixels: new Uint8Array(4),
      }),
  };
  return addon as NativeAddon;
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
      { type: 'wheel', window: 1, dy: 2 },
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

  it('locks the pointer in the relative mode, and shakes the gamepads', () => {
    const queue: RawWindowEvent[] = [];
    const calls: string[] = [];
    setAddon(fakeAddon(queue, calls));
    const window = new NativeWindow();
    const input = new Input(new NativeInputSource(window));
    input.lockPointer();
    // Relative: x and y stay, dx and dy move.
    queue.push(
      { type: 'pointermove', window: 1, x: 100, y: 50, dx: 20, dy: 0 },
      { type: 'pointermove', window: 1, x: 100, y: 50, dx: 20, dy: -10 },
    );
    NativeWindow.pollEvents();
    input.update();
    expect(window.pointerLocked).toBe(true);
    expect(input.pointer.locked).toBe(true);
    expect([input.pointer.dx, input.pointer.dy]).toEqual([0.2, -0.1]);
    input.lockPointer(false);
    input.update();
    expect(input.pointer.locked).toBe(false);
    input.gamepads[0].rumble(1, 0.5, 0.25);
    expect(calls).toEqual(['relative 1', 'relative 0', 'rumble 3 1 0.5 250']);
    input.dispose();
    window.destroy();
  });
});
