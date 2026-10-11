import { Input } from '@fdw/engine-input';
import { describe, expect, it } from 'vitest';
import { WebInputSource } from './WebInputSource';

// An element of the given size, and events with the fields of the DOM.
const setup = (pads: (Partial<Gamepad> | null)[] = []) => {
  const element = document.createElement('canvas');
  Object.defineProperty(element, 'clientWidth', { value: 200 });
  Object.defineProperty(element, 'clientHeight', { value: 100 });
  const source = new WebInputSource(element, {
    gamepads: { getGamepads: () => pads as Gamepad[] },
  });
  const input = new Input(source);
  const send = (type: string, fields: object) =>
    element.dispatchEvent(Object.assign(new Event(type), fields));
  return { element, source, input, send };
};

describe('WebInputSource', () => {
  it('gives the keys by position, and what they produce', () => {
    const { input, send } = setup();
    // W on an AZERTY keyboard: the key at the place of W produces "z".
    send('keydown', { code: 'KeyW', key: 'z' });
    input.update();
    expect(input.keyboard.isDown('KeyW')).toBe(true);
    expect(input.keyboard.label('KeyW')).toBe('Z');
    send('keyup', { code: 'KeyW', key: 'z' });
    input.update();
    expect(input.keyboard.released('KeyW')).toBe(true);
  });

  it('normalizes the pointer over the element, and the wheel in notches', () => {
    const { input, send } = setup();
    send('pointermove', { offsetX: 50, offsetY: 75 });
    send('pointerdown', { button: 2 });
    send('wheel', { deltaY: 200, deltaMode: 0 });
    send('wheel', { deltaY: 3, deltaMode: 1 });
    input.update();
    expect(input.pointer.x).toBe(0.25);
    expect(input.pointer.y).toBe(0.75);
    expect(input.pointer.isDown(2)).toBe(true);
    expect(input.pointer.wheel).toBe(3);
  });

  it('normalizes the pointer over the window', () => {
    const target = Object.assign(new EventTarget(), {
      innerWidth: 400,
      innerHeight: 200,
    }) as unknown as Window;
    const input = new Input(
      new WebInputSource(target, { gamepads: undefined })
    );
    target.dispatchEvent(
      Object.assign(new Event('pointermove'), { clientX: 100, clientY: 50 })
    );
    input.update();
    expect([input.pointer.x, input.pointer.y]).toEqual([0.25, 0.25]);
  });

  it('releases everything on blur, and stops listening when detached', () => {
    const { input, send } = setup();
    send('keydown', { code: 'Space', key: ' ' });
    send('blur', {});
    input.update();
    expect(input.keyboard.isDown('Space')).toBe(false);
    input.dispose();
    send('keydown', { code: 'KeyA', key: 'a' });
    input.update();
    expect(input.keyboard.isDown('KeyA')).toBe(false);
  });

  it('reads the gamepads of the standard layout', () => {
    const buttons = Array.from({ length: 17 }, () => ({ value: 0 }));
    buttons[7].value = 0.6; // the right trigger
    const pads = [
      null,
      {
        index: 1,
        id: 'Xbox controller',
        connected: true,
        mapping: 'standard' as const,
        buttons: buttons as unknown as GamepadButton[],
        axes: [0.5, -1, 0, 0],
      },
      // Its buttons have no known meaning: ignored.
      {
        index: 2,
        id: 'Joystick',
        connected: true,
        mapping: '' as const,
        buttons: [],
        axes: [],
      },
    ];
    const { input } = setup(pads);
    input.update();
    expect(input.gamepads.length).toBe(1);
    const [gamepad] = input.gamepads;
    expect(gamepad.name).toBe('Xbox controller');
    expect(gamepad.isDown('rightTrigger')).toBe(true);
    expect(gamepad.axis('leftY')).toBe(-1);
  });
});
