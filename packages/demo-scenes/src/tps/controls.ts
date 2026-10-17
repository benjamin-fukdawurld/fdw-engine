import { ThirdPersonActions } from '@fdw/engine-camera';
import { ActionMap, Input } from '@fdw/engine-input';

/** The two contexts of the game: one map of actions each. */
export interface TpsControls {
  /** Moving, fighting, the camera, pausing. */
  readonly game: ActionMap;
  /** Choosing an entry of the menu. */
  readonly menu: ActionMap;
}

/**
 * The actions of the game: those of the ThirdPersonOperator (the locked
 * pointer and the right stick turn the camera), plus WASD (ZQSD on AZERTY)
 * and the left stick to move, Shift to sprint, Space to jump, C to roll,
 * the left button to strike, the right one for a heavy blow, F to parry.
 * The game starts in the menu: the game map is disabled.
 */
export function tpsControls(input: Input): TpsControls {
  const game = new ActionMap(
    input,
    {
      ...ThirdPersonActions,
      // The right button is a blow here: the camera turns with the
      // pointer locked only.
      drag: { type: 'button', bindings: ['pointer:locked'] },
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
      sprint: {
        type: 'button',
        bindings: ['key:ShiftLeft', 'key:ShiftRight', 'gamepad:leftStick'],
      },
      jump: { type: 'button', bindings: ['key:Space', 'gamepad:south'] },
      roll: { type: 'button', bindings: ['key:KeyC', 'gamepad:east'] },
      attack: {
        type: 'button',
        bindings: ['pointer:0', 'gamepad:west', 'gamepad:rightShoulder'],
      },
      heavy: {
        type: 'button',
        bindings: [
          'pointer:2',
          'key:KeyE',
          'gamepad:north',
          'gamepad:rightTrigger',
        ],
      },
      block: {
        type: 'button',
        bindings: ['key:KeyF', 'gamepad:leftShoulder', 'gamepad:leftTrigger'],
      },
      // Escape quits the native demo: P pauses everywhere.
      pause: {
        type: 'button',
        bindings: ['key:Escape', 'key:KeyP', 'gamepad:start'],
      },
      locked: { type: 'button', bindings: ['pointer:locked'] },
    },
    { enabled: false },
  );
  const menu = new ActionMap(input, {
    up: {
      type: 'button',
      bindings: ['key:ArrowUp', 'key:KeyW', 'gamepad:dpadUp'],
    },
    down: {
      type: 'button',
      bindings: ['key:ArrowDown', 'key:KeyS', 'gamepad:dpadDown'],
    },
    confirm: {
      type: 'button',
      bindings: ['key:Enter', 'key:Space', 'pointer:0', 'gamepad:south'],
    },
  });
  return { game, menu };
}
