import { Camera } from '@fdw/engine-core';
import { Scene } from '@fdw/engine-scene';
import { followAspect, SceneFactory } from '../scene';
import { FlyCamera } from './flyCamera';
import { Input } from './input';
import { TopViewLayer } from './topView';
import { MazeView } from './view';
import { createMazeWorld, surfaceMaterial } from './world';

/**
 * Step 1 of the maze game: a generated maze of thousands of static nodes,
 * a camera flying over it, and a top view showing what the camera
 * retained.
 */
export const createMazeStep1: SceneFactory = (
  backend,
  surface,
  context = {}
) => {
  const scene = new Scene();
  const { level, sphere } = createMazeWorld(scene);

  // The camera, on a node moved by the fly camera.
  const camera = new Camera({
    projection: {
      type: 'perspective',
      fov: 50,
      aspect: 1,
      near: 0.5,
      far: 120,
    },
  });
  const input = new Input(context.input ?? new EventTarget());
  const fly = new FlyCamera(
    scene.root.add({ name: 'camera' }).setCamera(camera),
    input
  );
  // Where the camera is, for the top view only.
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
      fly.update(dt);
      marker.transform.position = { x: fly.x, y: 1, z: fly.z };
      followAspect(camera, surface);
      const stats = view.render(surface, camera);
      if (stats) {
        context.info?.(
          `${stats.drawn} of ${nodes} nodes drawn, ${stats.casters} shadow casters`
        );
      }
    },
    destroy: () => {
      input.dispose();
      view.destroy();
    },
  };
};
