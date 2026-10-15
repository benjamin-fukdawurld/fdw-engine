import { FlyActions } from '@fdw/engine-camera';
import { ActionMap, Input } from '@fdw/engine-input';

/** The two contexts of the game: one map of actions each. */
export interface FpsControls {
  /** Walking, looking, jumping, shooting, pausing. */
  readonly game: ActionMap;
  /** Choosing an entry of the menu. */
  readonly menu: ActionMap;
}

/**
 * The actions of the game: those of the FlyOperator (WASD and the left
 * stick walk, the locked pointer and the right stick look around), without
 * its `lift` (a walker does not fly), plus jumping, shooting and pausing.
 * The game starts in the menu: the game map is disabled.
 */
export function fpsControls(input: Input): FpsControls {
  const game = new ActionMap(
    input,
    {
      ...FlyActions,
      lift: { type: 'axis', bindings: [] },
      jump: { type: 'button', bindings: ['key:Space', 'gamepad:south'] },
      fire: {
        type: 'button',
        bindings: ['pointer:0', 'key:KeyF', 'gamepad:rightTrigger'],
      },
      // Escape quits the native demo: P pauses everywhere.
      pause: {
        type: 'button',
        bindings: ['key:Escape', 'key:KeyP', 'gamepad:start'],
      },
      locked: { type: 'button', bindings: ['pointer:locked'] },
    },
    { enabled: false }
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
