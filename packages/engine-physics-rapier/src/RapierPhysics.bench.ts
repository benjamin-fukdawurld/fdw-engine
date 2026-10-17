import { bench, describe } from 'vitest';
import { ScenePhysics, Shapes } from '@fdw/engine-physics';
import { Scene } from '@fdw/engine-scene';
import { createRapierPhysics } from './RapierPhysics';

// The cost of a step: 1000 boxes, 10 × 10 × 10, falling on a ground, all
// awake (measured during their first second, before they sleep); the same
// boxes as nodes of a scene, their poses read and written by ScenePhysics.
const engine = await createRapierPhysics();

function boxes(physics?: ScenePhysics) {
  const world = physics?.world ?? engine.createWorld();
  world.createBody({
    type: 'static',
    position: { y: -0.5 },
    colliders: [{ shape: Shapes.box(50, 0.5, 50) }],
  });
  for (let i = 0; i < 1000; i++) {
    const position = {
      x: (i % 10) * 1.1 - 5,
      y: 1 + Math.floor(i / 100) * 1.1,
      z: (Math.floor(i / 10) % 10) * 1.1 - 5,
    };
    const desc = {
      type: 'dynamic' as const,
      colliders: [{ shape: Shapes.box(0.5) }],
    };
    if (physics) {
      physics.add(physics.scene.root.add({ position }), desc);
    } else {
      world.createBody({ ...desc, position });
    }
  }
  return world;
}

describe('Rapier', () => {
  let world = boxes();
  let steps = 0;
  bench(
    'step, 1000 boxes falling',
    () => {
      // A new pile every second simulated: always awake.
      if (++steps === 60) {
        world.destroy();
        world = boxes();
        steps = 0;
      }
      world.step(1 / 60);
    },
    { time: 2000 },
  );

  let physics = new ScenePhysics(new Scene(), engine.createWorld());
  boxes(physics);
  let sceneSteps = 0;
  bench(
    'step and sync of ScenePhysics, 1000 boxes falling',
    () => {
      if (++sceneSteps === 60) {
        physics.world.destroy();
        physics = new ScenePhysics(new Scene(), engine.createWorld());
        boxes(physics);
        sceneSteps = 0;
      }
      physics.step(1 / 60);
      physics.sync(0.5);
    },
    { time: 2000 },
  );
});
