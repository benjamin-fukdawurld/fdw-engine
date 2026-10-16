import { Camera } from '@fdw/engine-core';
import { FakeInputSource, Input } from '@fdw/engine-input';
import { Scene, Scheduler } from '@fdw/engine-scene';
import { followAspect, SceneFactory } from '../scene';
import { mazeActions } from './controls';
import { Aim } from './aim';
import { Exploration } from './exploration';
import { Flashlight } from './flashlight';
import { FollowCamera } from './followCamera';
import { MazeGame } from './game';
import { MazeMap } from './map';
import { Player } from './player';
import { TopViewLayer } from './topView';
import { MazeView } from './view';
import { createMazeWorld, surfaceMaterial } from './world';

// How often the flashlight discovers cells, in seconds.
const lightPeriod = 0.1;

/**
 * Step 4 of the maze game: the game. Gems to collect in the dark, an exit
 * opening once they all are, enemies chasing the player when they see it,
 * dazzled by the flashlight; a map of what was discovered.
 */
export const createMazeStep4: SceneFactory = (
  backend,
  surface,
  context = {},
) => {
  const scene = new Scene();
  const { level, cube, sphere } = createMazeWorld(scene, { sun: false });
  const Solid = scene.world.defineComponent('solid', {});
  for (const wall of level.walls.children) {
    wall.attach(Solid);
  }

  // No source: an input nobody drives.
  const input = new Input(context.input ?? new FakeInputSource());
  const actions = mazeActions(input);
  const player = new Player(scene, Solid, level.cellCenter(0, 0), {
    sphere,
    cube,
    body: surfaceMaterial([0.95, 0.55, 0.15], 0.45),
  });
  const flashlight = new Flashlight(player.node);

  const camera = new Camera({
    projection: {
      type: 'perspective',
      fov: 50,
      aspect: 1,
      near: 0.3,
      far: 60,
    },
  });
  const eye = scene.root.add({ name: 'camera' }).setCamera(camera);
  const follow = new FollowCamera(eye, actions);
  const aimer = new Aim();
  // The marker of the player in the top view of the culling (C).
  const marker = scene.root
    .add({ name: 'marker', layers: TopViewLayer, scale: { x: 3, y: 3, z: 3 } })
    .setMesh(sphere, surfaceMaterial([1, 0.3, 0.1], 0.5), {
      castShadow: false,
    });

  const view = new MazeView(backend, scene, level);
  const exploration = new Exploration(level);
  const map = new MazeMap(backend, view.renderer, exploration);
  const game = new MazeGame(
    scene,
    level,
    Solid,
    player,
    flashlight,
    exploration,
    { cube, sphere },
  );
  let lightTime = 0;
  let showCulling = false;
  let aim: { x: number; z: number } | undefined;

  // The frame, in systems: the input at the start, the logic at a fixed
  // step, the camera and the map once per frame, the rendering last.
  const scheduler = new Scheduler();

  // begin: the events since the previous frame, and what they switch.
  scheduler.add(
    'input',
    () => {
      input.update();
      followAspect(camera, surface);
      if (actions.button('flashlight').pressed) {
        flashlight.on = !flashlight.on;
      }
      if (actions.button('culling').pressed) {
        showCulling = !showCulling;
      }
      if (actions.button('map').pressed) {
        map.zoom = map.zoom === undefined ? 16 : undefined;
      }
      if (actions.button('restart').pressed && game.state !== 'playing') {
        game.reset();
        scheduler.paused = false;
      }
    },
    { phase: 'begin' },
  );
  scheduler.add(
    'aim',
    () => {
      aim = aimer.update(
        input,
        actions,
        eye,
        camera,
        player.position,
        follow.yaw,
      );
    },
    { phase: 'begin', after: ['input'] },
  );

  // fixed: the logic.
  scheduler.add(
    'player',
    (step) => player.update(step, actions, follow.yaw, aim),
    { phase: 'fixed' },
  );
  scheduler.add(
    'exploration',
    (step) => {
      exploration.walk(player.position);
      lightTime += step;
      if (lightTime >= lightPeriod && flashlight.on) {
        exploration.light(scene, Solid, flashlight.beam);
        lightTime = 0;
      }
    },
    { phase: 'fixed', after: ['player'] },
  );
  scheduler.add(
    'game',
    (step) => {
      game.update(step);
      // Won or lost: the logic stops at once, the rest goes on.
      if (game.state !== 'playing') {
        scheduler.paused = true;
      }
    },
    { phase: 'fixed', after: ['exploration'] },
  );

  // update: the camera, the markers.
  scheduler.add('camera', (dt) => follow.update(dt, player.position));
  scheduler.add('marks', () => {
    marker.transform.position = {
      x: player.position.x,
      y: 1,
      z: player.position.z,
    };
    map.setPlayer(player.position, player.heading);
    map.setMarks([
      ...game.gemCells().map((cell) => ({
        cell,
        color: [50, 210, 255] as const,
      })),
      {
        cell: game.exitCell,
        color:
          game.collected === game.total
            ? ([40, 230, 90] as const)
            : ([200, 30, 20] as const),
      },
    ]);
  });

  // render: the view, and the state of the game.
  scheduler.add(
    'render',
    () => {
      const stats = view.render(surface, camera, {
        cullUnlit: true,
        background: { r: 0, g: 0, b: 0 },
        inset: showCulling ? view.topView : map,
      });
      const explored = (
        (exploration.count * 100) /
        exploration.discovered.length
      ).toFixed(1);
      const status =
        game.state === 'won'
          ? 'You escaped! R to play again'
          : game.state === 'lost'
            ? 'Caught! R to play again'
            : `${game.collected} of ${game.total} gems · ${explored} % explored`;
      context.info?.(
        stats
          ? `${status} · ${stats.drawn} nodes drawn, ${stats.lights} lights`
          : status,
      );
    },
    { phase: 'render' },
  );

  let last = 0;
  return {
    frame: (time) => {
      scheduler.update(Math.min(time - last, 0.1));
      last = time;
    },
    destroy: () => {
      input.dispose();
      map.destroy();
      view.destroy();
    },
  };
};
