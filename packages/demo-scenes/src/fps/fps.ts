import { Camera, Renderer } from '@fdw/engine-core';
import { FakeInputSource, Input } from '@fdw/engine-input';
import { Scene, Scheduler } from '@fdw/engine-scene';
import { followAspect, SceneFactory } from '../scene';
import { buildArena } from './arena';
import { fpsControls } from './controls';
import { FpsGame } from './game';

// The speeds of the pointer the menu offers, in radians per height of the
// surface.
const sensitivities = [
  { name: 'low', speed: 1.2 },
  { name: 'normal', speed: 2 },
  { name: 'high', speed: 3.5 },
];

/**
 * A first person shooter: an arena, waves of drones, a weapon. The pointer
 * locked to look around, a pause menu over the game, the gamepad that
 * rumbles; the frame run by a scheduler, the drones at a fixed step and
 * drawn between two steps.
 */
export const createFpsScene: SceneFactory = (
  backend,
  surface,
  context = {},
) => {
  const scene = new Scene();
  const arena = buildArena(scene);
  // No source: an input nobody drives.
  const input = new Input(context.input ?? new FakeInputSource());
  const { game: actions, menu } = fpsControls(input);
  const camera = new Camera({
    projection: {
      type: 'perspective',
      fov: 70,
      aspect: 16 / 9,
      near: 0.05,
      far: 120,
    },
  });
  const game = new FpsGame(scene, arena, camera, actions);
  const { player } = game;
  const renderer = new Renderer(backend, {
    output: { toneMapping: 'neutral', encoding: 'srgb' },
  });
  const scheduler = new Scheduler();

  // The menu: open at the start, at a pause, at the end of a game.
  let started = false;
  let sensitivity = 1;
  let selected = 0;
  const play = () => {
    if (game.state === 'over') {
      game.reset();
    }
    started = true;
    menu.enabled = false;
    actions.enabled = true;
    scheduler.paused = false;
    // After a click or a key: the browser accepts the lock.
    input.lockPointer();
  };
  const pause = () => {
    actions.enabled = false;
    menu.enabled = true;
    scheduler.paused = true;
    selected = 0;
    input.lockPointer(false);
  };
  const entries = [
    {
      label: () =>
        game.state === 'over' ? 'Play again' : started ? 'Resume' : 'Play',
      choose: play,
    },
    {
      label: () => `Rumble: ${game.rumble ? 'on' : 'off'}`,
      choose: () => {
        game.rumble = !game.rumble;
        if (game.rumble) {
          menu.rumble(0.5, 0.5, 0.15);
        }
      },
    },
    {
      label: () => `Invert Y: ${player.fly.invertY ? 'on' : 'off'}`,
      choose: () => {
        player.fly.invertY = !player.fly.invertY;
      },
    },
    {
      label: () => `Sensitivity: ${sensitivities[sensitivity].name}`,
      choose: () => {
        sensitivity = (sensitivity + 1) % sensitivities.length;
        player.fly.pointerSpeed = sensitivities[sensitivity].speed;
      },
    },
  ];
  scheduler.paused = true;

  // begin: the events since the previous frame; the menu, the pause.
  scheduler.add(
    'input',
    () => {
      input.update();
      followAspect(camera, surface);
      if (menu.active) {
        const count = entries.length;
        if (menu.button('up').pressed) {
          selected = (selected + count - 1) % count;
        }
        if (menu.button('down').pressed) {
          selected = (selected + 1) % count;
        }
        if (menu.button('confirm').pressed) {
          entries[selected].choose();
        }
      } else if (actions.active) {
        // Escape releases the lock in a browser: the game pauses then.
        if (
          actions.button('pause').pressed ||
          actions.button('locked').released
        ) {
          pause();
        } else if (
          actions.button('fire').pressed &&
          !input.pointer.locked &&
          input.pointer.pressed(0)
        ) {
          // Unlocked, a click locks the pointer again.
          input.lockPointer();
        }
      }
    },
    { phase: 'begin' },
  );

  // fixed: the drones, their blows, the waves; paused under the menu.
  scheduler.add('drones', (step) => game.drones.steer(step, player.position), {
    phase: 'fixed',
  });
  scheduler.add(
    'strikes',
    (step) => {
      game.strikes(step);
      // The player down: the logic stops at once, the menu opens.
      if (game.state === 'over') {
        pause();
      }
    },
    { phase: 'fixed', after: ['drones'] },
  );
  scheduler.add('fade', (step) => game.drones.fade(step), {
    phase: 'fixed',
    after: ['strikes'],
  });
  scheduler.add('waves', (step) => game.waves(step), {
    phase: 'fixed',
    after: ['fade'],
  });

  // update: the player looks and walks at the rate of the screen; the
  // drones are drawn between their last two steps, then the shots, which
  // hit what is drawn.
  scheduler.add('player', (dt) => {
    if (actions.enabled) {
      player.update(dt);
    }
  });
  scheduler.add('draw', () =>
    game.drones.draw(scheduler.alpha, player.position),
  );
  scheduler.add('shoot', () => game.shoot(), { after: ['player', 'draw'] });
  scheduler.add(
    'effects',
    (dt) => {
      game.weapon.update(dt, player.walked);
      game.sparks.update(dt);
      game.hurt = Math.max(0, game.hurt - dt);
    },
    { after: ['shoot'] },
  );

  // render: the view, dimmed under the menu, darker at a blow; the state.
  scheduler.add(
    'render',
    () => {
      renderer.render({
        source: scene,
        camera,
        surface,
        exposure: menu.enabled ? 0.35 : 1 - game.hurt * 2,
        clearColor: { r: 0.55, g: 0.45, b: 0.42, a: 1 },
      });
    },
    { phase: 'render' },
  );
  scheduler.add(
    'status',
    () => {
      const state = game.status();
      context.info?.(
        menu.enabled
          ? `${state} · ${entries
              .map(({ label }, i) =>
                i === selected ? `[${label()}]` : label(),
              )
              .join(' · ')}`
          : `${state} · ${
              input.pointer.locked ? 'Esc or P: menu' : 'click to look around'
            }`,
      );
    },
    { phase: 'render', after: ['render'] },
  );

  let last = 0;
  return {
    frame: (time) => {
      scheduler.update(Math.min(time - last, 0.1));
      last = time;
    },
    destroy: () => {
      input.dispose();
      renderer.destroy();
    },
  };
};
