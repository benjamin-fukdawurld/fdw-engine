import { describe, expect, it } from 'vitest';
import { ScenePhysics, Shapes } from '@fdw/engine-physics';
import { Scene, Scheduler } from '@fdw/engine-scene';
import { createRapierPhysics } from './RapierPhysics';

// The binding of engine-physics, on Rapier: the bodies as components of a
// scene, the simulation in the fixed step of a scheduler.
describe('ScenePhysics on Rapier', () => {
  it('stacks boxes on the ground, their nodes following', async () => {
    const engine = await createRapierPhysics();
    const scene = new Scene();
    const physics = new ScenePhysics(scene, engine.createWorld());
    physics.add(scene.root.add({ position: { y: -0.5 } }), {
      type: 'static',
      colliders: [{ shape: Shapes.box(10, 0.5, 10) }],
    });
    const boxes = [0, 1, 2].map((i) => {
      const node = scene.root.add({ position: { y: 1 + i * 1.5 } });
      physics.add(node, {
        type: 'dynamic',
        colliders: [{ shape: Shapes.box(0.5) }],
      });
      return node;
    });
    const scheduler = new Scheduler();
    physics.install(scheduler);
    for (let frame = 0; frame < 240; frame++) {
      scheduler.update(1 / 60);
    }
    // A stack, a meter per box.
    boxes.forEach((node, i) => {
      expect(node.transform.position.y).toBeCloseTo(0.5 + i, 1);
      expect(node.worldPosition.y).toBeCloseTo(0.5 + i, 1);
    });
    expect(physics.bodyOf(boxes[2])?.sleeping).toBe(true);

    // A ray down the stack hits the top box.
    const hit = physics.world.raycast(
      { x: 0, y: 10, z: 0 },
      { x: 0, y: -1, z: 0 },
      20,
    );
    expect(hit && physics.nodeOf(hit.collider)?.entity).toBe(boxes[2].entity);

    // Removing a node removes its body: the top box falls on the ground.
    boxes[1].remove();
    for (let frame = 0; frame < 120; frame++) {
      scheduler.update(1 / 60);
    }
    expect(boxes[2].transform.position.y).toBeCloseTo(1.5, 1);
    physics.destroy();
    expect([...physics.world.bodies]).toHaveLength(0);
    physics.world.destroy();
  });

  it('walks a character node, which follows its body', async () => {
    const engine = await createRapierPhysics();
    const scene = new Scene();
    const physics = new ScenePhysics(scene, engine.createWorld());
    physics.add(scene.root.add({ position: { y: -0.5 } }), {
      type: 'static',
      colliders: [{ shape: Shapes.box(10, 0.5, 10) }],
    });
    const node = scene.root.add({ position: { y: 1 } });
    const character = physics.addCharacter(node, {
      shape: Shapes.capsule(0.5, 0.3),
    });
    expect(physics.characterOf(node)).toBe(character);
    const scheduler = new Scheduler();
    scheduler.add(
      'walk',
      (dt) => character.move({ x: 2 * dt, y: -5 * dt, z: 0 }),
      {
        phase: 'fixed',
        before: ['physics'],
      },
    );
    physics.install(scheduler);
    for (let frame = 0; frame < 60; frame++) {
      scheduler.update(1 / 60);
    }
    expect(character.grounded).toBe(true);
    expect(node.transform.position.x).toBeCloseTo(2, 0);
    expect(node.transform.position.y).toBeCloseTo(0.82, 1);
    node.remove();
    expect([...physics.world.bodies]).toHaveLength(1);
    physics.world.destroy();
  });
});
