import { describe, expect, it } from 'vitest';
import { ActionMap } from './ActionMap';
import { FakeInputSource } from './FakeInputSource';
import { Input } from './Input';

const setup = () => {
  const source = new FakeInputSource();
  const input = new Input(source);
  return { source, input };
};

describe('Input', () => {
  it('keeps the state of the keyboard for a frame', () => {
    const { source, input } = setup();
    source.keyDown('KeyW', 'z');
    // Not before the update.
    expect(input.keyboard.isDown('KeyW')).toBe(false);
    input.update();
    expect(input.keyboard.isDown('KeyW')).toBe(true);
    expect(input.keyboard.pressed('KeyW')).toBe(true);
    // Held: pressed once.
    source.keyDown('KeyW', 'z');
    input.update();
    expect(input.keyboard.isDown('KeyW')).toBe(true);
    expect(input.keyboard.pressed('KeyW')).toBe(false);
    source.keyUp('KeyW', 'z');
    input.update();
    expect(input.keyboard.isDown('KeyW')).toBe(false);
    expect(input.keyboard.released('KeyW')).toBe(true);
    // The label of the key in the layout.
    expect(input.keyboard.label('KeyW')).toBe('Z');
    expect(input.keyboard.label('KeyQ')).toBe('KeyQ');
  });

  it('does not lose a press shorter than a frame', () => {
    const { source, input } = setup();
    source.keyDown('KeyF');
    source.keyUp('KeyF');
    input.update();
    expect(input.keyboard.pressed('KeyF')).toBe(true);
    expect(input.keyboard.isDown('KeyF')).toBe(false);
    input.update();
    expect(input.keyboard.pressed('KeyF')).toBe(false);
  });

  it('releases everything when the focus is lost', () => {
    const { source, input } = setup();
    source.keyDown('KeyW');
    source.sink?.pointerButton(0, true);
    input.update();
    source.sink?.blur();
    input.update();
    expect(input.keyboard.isDown('KeyW')).toBe(false);
    expect(input.keyboard.released('KeyW')).toBe(true);
    expect(input.pointer.isDown(0)).toBe(false);
  });

  it('gives the pointer and the wheel of the frame', () => {
    const { source, input } = setup();
    source.sink?.pointerMove(0.25, 0.75);
    source.sink?.wheel(1);
    source.sink?.wheel(2);
    input.update();
    expect(input.pointer).toMatchObject({ x: 0.25, y: 0.75, moved: true });
    expect(input.pointer.wheel).toBe(3);
    expect(input.lastDevice).toBe('pointer');
    input.update();
    expect(input.pointer).toMatchObject({ x: 0.25, moved: false, wheel: 0 });
    expect(input.pointer.seen).toBe(true);
  });

  it('follows the gamepads, connected and disconnected', () => {
    const { source, input } = setup();
    const pad = source.connectGamepad('Pad');
    input.update();
    expect(input.gamepads.map((g) => g.name)).toEqual(['Pad']);
    const [gamepad] = input.gamepads;
    source.setButton(pad, 'south', 1);
    source.setButton(pad, 'rightTrigger', 0.3);
    input.update();
    expect(gamepad.pressed('south')).toBe(true);
    expect(gamepad.isDown('rightTrigger')).toBe(false);
    expect(gamepad.value('rightTrigger')).toBeCloseTo(0.3);
    expect(input.lastDevice).toBe('gamepad');
    input.update();
    expect(gamepad.pressed('south')).toBe(false);
    expect(gamepad.isDown('south')).toBe(true);
    source.setButton(pad, 'south', 0);
    input.update();
    expect(gamepad.released('south')).toBe(true);
    source.disconnectGamepad(pad);
    input.update();
    expect(input.gamepads).toEqual([]);
  });

  it('applies a radial dead zone to the sticks', () => {
    const { source, input } = setup();
    const pad = source.connectGamepad();
    input.update();
    const [gamepad] = input.gamepads;
    // At rest, a little off: zero.
    source.setAxis(pad, 'leftX', 0.1);
    source.setAxis(pad, 'leftY', -0.05);
    input.update();
    expect(gamepad.stick('left')).toEqual({ x: 0, y: 0 });
    // Pushed along a diagonal: the same direction, rescaled.
    source.setAxis(pad, 'leftX', 0.5);
    source.setAxis(pad, 'leftY', 0.5);
    input.update();
    const { x, y } = gamepad.stick('left');
    expect(x).toBeCloseTo(y, 6);
    const length = (Math.SQRT1_2 - 0.15) / 0.85;
    expect(Math.hypot(x, y)).toBeCloseTo(length, 5);
    // Fully pushed: length 1.
    source.setAxis(pad, 'leftX', 1);
    source.setAxis(pad, 'leftY', 0);
    input.update();
    expect(gamepad.stick('left')).toEqual({ x: 1, y: 0 });
  });
});

describe('ActionMap', () => {
  const definitions = {
    jump: { type: 'button', bindings: ['key:Space', 'gamepad:south'] },
    fire: { type: 'button', bindings: ['pointer:0', 'gamepad:rightTrigger'] },
    zoom: {
      type: 'axis',
      bindings: [
        'pointer:wheel',
        { negative: 'gamepad:dpadUp', positive: 'gamepad:dpadDown' },
      ],
    },
    move: {
      type: 'vector',
      bindings: [
        {
          up: 'key:KeyW',
          down: 'key:KeyS',
          left: 'key:KeyA',
          right: 'key:KeyD',
        },
        'gamepad:leftStick',
      ],
    },
  } as const;

  it('reads buttons from any of their controls', () => {
    const { source, input } = setup();
    const actions = new ActionMap(input, definitions);
    const pad = source.connectGamepad();
    source.keyDown('Space');
    input.update();
    expect(actions.button('jump')).toMatchObject({ down: true, pressed: true });
    // Held by the gamepad, released by the keyboard: still down.
    source.setButton(pad, 'south', 1);
    source.keyUp('Space');
    input.update();
    expect(actions.button('jump')).toMatchObject({
      down: true,
      released: false,
    });
    // A trigger counts beyond half way.
    source.setButton(pad, 'rightTrigger', 0.4);
    input.update();
    expect(actions.button('fire')).toMatchObject({ down: false, value: 0 });
    source.setButton(pad, 'rightTrigger', 0.8);
    input.update();
    expect(actions.button('fire').down).toBe(true);
    expect(actions.button('fire').value).toBeCloseTo(0.8);
  });

  it('reads axes, the strongest binding winning', () => {
    const { source, input } = setup();
    const actions = new ActionMap(input, definitions);
    const pad = source.connectGamepad();
    source.sink?.wheel(-2);
    source.setButton(pad, 'dpadDown', 1);
    input.update();
    expect(actions.axis('zoom')).toBe(-2);
    input.update();
    expect(actions.axis('zoom')).toBe(1);
  });

  it('reads vectors: four keys normalized, or a stick, y forward', () => {
    const { source, input } = setup();
    const actions = new ActionMap(input, definitions);
    source.keyDown('KeyW');
    source.keyDown('KeyD');
    input.update();
    const { x, y } = actions.vector('move');
    expect(x).toBeCloseTo(Math.SQRT1_2);
    expect(y).toBeCloseTo(Math.SQRT1_2);
    source.keyUp('KeyW');
    source.keyUp('KeyD');
    const pad = source.connectGamepad();
    // Pushed up: y negative on the stick, forward for the action.
    source.setAxis(pad, 'leftY', -1);
    input.update();
    expect(actions.vector('move')).toEqual({ x: 0, y: 1 });
  });

  it('changes and saves its bindings', () => {
    const { source, input } = setup();
    const actions = new ActionMap(input, definitions);
    actions.rebind('jump', ['key:KeyJ']);
    const saved = JSON.parse(JSON.stringify(actions));
    expect(saved.jump).toEqual(['key:KeyJ']);
    const restored = new ActionMap(input, definitions, { bindings: saved });
    source.keyDown('KeyJ');
    input.update();
    expect(restored.button('jump').pressed).toBe(true);
    expect(() => actions.button('move')).toThrow(/vector/);
    expect(() => actions.axis('nothing')).toThrow(/No action/);
  });

  it('reads one gamepad when given', () => {
    const { source, input } = setup();
    source.connectGamepad('first');
    const second = source.connectGamepad('second');
    const player2 = new ActionMap(input, definitions, { gamepad: 1 });
    const player1 = new ActionMap(input, definitions, { gamepad: 0 });
    source.setButton(second, 'south', 1);
    input.update();
    expect(player2.button('jump').down).toBe(true);
    expect(player1.button('jump').down).toBe(false);
  });
});
