import { Camera } from '@fdw/engine-core';
import { FakeInputSource, Input } from '@fdw/engine-input';
import { Scene } from '@fdw/engine-scene';
import { followAspect, SceneFactory } from '../scene';
import { mazeActions } from './controls';
import { Aim } from './aim';
import { Flashlight } from './flashlight';
import { FollowCamera } from './followCamera';
import { Player } from './player';
import { TopViewLayer } from './topView';
import { MazeView } from './view';
import { createMazeWorld, surfaceMaterial } from './world';

/**
 * Step 3 of the maze game: the dark. The character carries a flashlight,
 * aimed with the pointer; only what it lights is seen, and drawn.
 */
export const createMazeStep3: SceneFactory = (
  backend,
  surface,
  context = {},
) => {
  const scene = new Scene();
  // No sun: the only lights are those of the character.
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
  const marker = scene.root
    .add({ name: 'marker', layers: TopViewLayer, scale: { x: 3, y: 3, z: 3 } })
    .setMesh(sphere, surfaceMaterial([1, 0.3, 0.1], 0.5), {
      castShadow: false,
    });

  const view = new MazeView(backend, scene, level);
  const nodes =
    level.maze.width * level.maze.height + level.walls.children.length;
  let last = 0;

  return {
    frame: (time) => {
      const dt = Math.min(time - last, 0.1);
      last = time;
      // The events since the previous frame.
      input.update();
      followAspect(camera, surface);
      // F switches the flashlight, once per press.
      if (actions.button('flashlight').pressed) {
        flashlight.on = !flashlight.on;
      }
      // The character faces the point of the ground under the pointer, or
      // the direction of the right stick.
      const aim = aimer.update(
        input,
        actions,
        eye,
        camera,
        player.position,
        follow.yaw,
      );
      player.update(dt, actions, follow.yaw, aim);
      follow.update(dt, player.position);
      marker.transform.position = {
        x: player.position.x,
        y: 1,
        z: player.position.z,
      };
      // Only bounded lights: what they do not reach is black, not drawn;
      // on a black background, where the drawing stops does not show.
      const stats = view.render(surface, camera, {
        cullUnlit: true,
        background: { r: 0, g: 0, b: 0 },
      });
      if (stats) {
        context.info?.(
          `${stats.drawn} of ${nodes} nodes drawn, ${stats.lights} lights, ${stats.casters} shadow casters`,
        );
      }
    },
    destroy: () => {
      input.dispose();
      view.destroy();
    },
  };
};
