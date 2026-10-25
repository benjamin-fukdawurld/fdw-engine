import { Camera, Renderer } from '@fdw/engine-core';
import { FakeInputSource, Input } from '@fdw/engine-input';
import { Scene, Scheduler } from '@fdw/engine-scene';
import { followAspect, SceneFactory } from '../scene';
import { buildArena } from './arena';
import { fpsControls } from './controls';
import { FpsGame } from './game';
import { FpsSounds } from './sounds';
import { RayView } from '../rays';

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
  const { audio } = context;
  // Made with the game, which tells them what happens.
  let sounds = undefined as FpsSounds | undefined;
  const game = new FpsGame(
    scene,
    arena,
    camera,
    actions,
    audio && ((eye) => (sounds = new FpsSounds(scene, audio, eye))),
  );
  const { player } = game;
  const renderer = new Renderer(backend, {
    output: { toneMapping: 'neutral', encoding: 'srgb' },
  });
  const scheduler = new Scheduler();
  // Rasterized, or with rays (where the backend traces them): the menu.
  const view = new RayView(renderer, backend);
  view.mode = context.rays ?? 'raster';

  // The menu: open at the start, at a pause, at the end of a game.
  let started = false;
  let sensitivity = 1;
  let selected = 0;
  const play = () => {
    if (game.state === 'over') {
      game.reset();
    }
    started = true;
    sounds?.menu(false);
    menu.enabled = false;
    actions.enabled = true;
    scheduler.paused = false;
    // After a click or a key: the browser accepts the lock.
    input.lockPointer();
  };
  const pause = () => {
    actions.enabled = false;
    sounds?.menu(true);
    menu.enabled = true;
    scheduler.paused = true;
    sounds?.menu(true);
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
    ...(audio
      ? [
          {
            label: () => `Sound: ${audio.master.muted ? 'off' : 'on'}`,
            choose: () => {
              audio.master.muted = !audio.master.muted;
            },
          },
        ]
      : []),
    {
      label: () => `Invert Y: ${player.fly.invertY ? 'on' : 'off'}`,
      choose: () => {
        player.fly.invertY = !player.fly.invertY;
      },
    },
    ...(view.available
      ? [
          {
            label: () => `Rendering: ${view.mode}`,
            choose: () => view.cycle(),
          },
        ]
      : []),
    {
      label: () => `Sensitivity: ${sensitivities[sensitivity].name}`,
      choose: () => {
        sensitivity = (sensitivity + 1) % sensitivities.length;
        player.fly.pointerSpeed = sensitivities[sensitivity].speed;
      },
    },
  ];
  scheduler.paused = true;
  sounds?.menu(true);

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

  // render: the sounds where the nodes are drawn; the view, dimmed under
  // the menu, darker at a blow; the state.
  if (sounds) {
    scheduler.add('audio', () => sounds?.update(), { phase: 'render' });
  }
  scheduler.add(
    'render',
    () => {
      view.render({
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
      sounds?.destroy();
      input.dispose();
      view.destroy();
      renderer.destroy();
    },
  };
};
