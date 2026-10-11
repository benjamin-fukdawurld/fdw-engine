import { ActionMap, ActionMapOptions, Input } from '@fdw/engine-input';

/**
 * The actions of the game, and their bindings: the keys by position (WASD
 * is ZQSD on an AZERTY keyboard), the mouse, the gamepad.
 */
export function mazeActions(
  input: Input,
  options?: ActionMapOptions
): ActionMap {
  return new ActionMap(
    input,
    {
      move: {
        type: 'vector',
        bindings: [
          {
            up: 'key:KeyW',
            down: 'key:KeyS',
            left: 'key:KeyA',
            right: 'key:KeyD',
          },
          {
            up: 'key:ArrowUp',
            down: 'key:ArrowDown',
            left: 'key:ArrowLeft',
            right: 'key:ArrowRight',
          },
          'gamepad:leftStick',
        ],
      },
      run: {
        type: 'button',
        bindings: ['key:ShiftLeft', 'key:ShiftRight', 'gamepad:leftStick'],
      },
      // The direction of the flashlight with a gamepad; the mouse aims at
      // the point under the pointer (see Aim).
      aim: { type: 'vector', bindings: ['gamepad:rightStick'] },
      // Around the target, positive to the left.
      turn: {
        type: 'axis',
        bindings: [
          { negative: 'key:KeyE', positive: 'key:KeyQ' },
          {
            negative: 'gamepad:rightShoulder',
            positive: 'gamepad:leftShoulder',
          },
        ],
      },
      // Closer (negative) or further, held: the pad.
      zoom: {
        type: 'axis',
        bindings: [
          { negative: 'gamepad:dpadUp', positive: 'gamepad:dpadDown' },
        ],
      },
      // The same, by steps: the notches of the wheel.
      zoomStep: { type: 'axis', bindings: ['pointer:wheel'] },
      flashlight: {
        type: 'button',
        bindings: ['key:KeyF', 'gamepad:west', 'gamepad:rightTrigger'],
      },
      map: { type: 'button', bindings: ['key:KeyM', 'gamepad:back'] },
      culling: { type: 'button', bindings: ['key:KeyC'] },
      restart: { type: 'button', bindings: ['key:KeyR', 'gamepad:start'] },
    },
    options
  );
}
