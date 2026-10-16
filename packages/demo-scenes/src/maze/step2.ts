import { Camera } from '@fdw/engine-core';
import { FakeInputSource, Input } from '@fdw/engine-input';
import { Scene } from '@fdw/engine-scene';
import { followAspect, SceneFactory } from '../scene';
import { mazeActions } from './controls';
import { FollowCamera } from './followCamera';
import { Player } from './player';
import { TopViewLayer } from './topView';
import { MazeView } from './view';
import { createMazeWorld, surfaceMaterial } from './world';

/**
 * Step 2 of the maze game: a character walking in the maze, colliding with
 * its walls, followed by the camera.
 */
export const createMazeStep2: SceneFactory = (
  backend,
  surface,
  context = {},
) => {
  const scene = new Scene();
  const { level, cube, sphere } = createMazeWorld(scene);

  // A component of the game: what the character cannot walk through. The
  // walls of the level have it.
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

  // Close to the character: a short far plane, few nodes in view.
  const camera = new Camera({
    projection: {
      type: 'perspective',
      fov: 50,
      aspect: 1,
      near: 0.3,
      far: 60,
    },
  });
  const follow = new FollowCamera(
    scene.root.add({ name: 'camera' }).setCamera(camera),
    actions,
  );
  // The character, seen from above: too small at the scale of the top view.
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
      player.update(dt, actions, follow.yaw);
      follow.update(dt, player.position);
      marker.transform.position = {
        x: player.position.x,
        y: 1,
        z: player.position.z,
      };
      followAspect(camera, surface);
      const stats = view.render(surface, camera);
      if (stats) {
        context.info?.(
          `${stats.drawn} of ${nodes} nodes drawn, ${stats.casters} shadow casters`,
        );
      }
    },
    destroy: () => {
      input.dispose();
      view.destroy();
    },
  };
};
