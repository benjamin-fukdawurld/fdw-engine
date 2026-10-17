# @fdw/engine-physics

The physics of FdwEngine, without a physics engine: the abstract API a physics engine implements (worlds, bodies, colliders, shapes, joints, queries, contact and sensor events, character controllers), its binding to the scene (`ScenePhysics`: the bodies as components of the entities, the simulation in the fixed step of the scheduler, the nodes drawn between two steps) and a debug view (the shapes, contacts, joints and rays, in lines). `@fdw/engine-physics-rapier` implements it on Rapier. See [design/p7b-physics.md](../../design/p7b-physics.md) (in French), the [tutorial](https://benjamin-fukdawurld.github.io/fdw-engine/tutorials/physics/) and the [guide](https://benjamin-fukdawurld.github.io/fdw-engine/guides/physics/).

```ts
import { PhysicsDebugView, ScenePhysics, Shapes } from '@fdw/engine-physics';
import { createRapierPhysics } from '@fdw/engine-physics-rapier';

const world = (await createRapierPhysics()).createWorld();
const physics = new ScenePhysics(scene, world);
physics.add(ground, {
  type: 'static',
  colliders: [{ shape: Shapes.box(8, 0.5, 8) }],
});
physics.add(box, { type: 'dynamic', colliders: [{ shape: Shapes.box(0.5) }] });
physics.install(scheduler); // physics (fixed), physics:sync (update)

const hit = world.raycast(origin, direction, 100);
const debug = new PhysicsDebugView(scene, world); // debug.update(dt) each frame
```

- **The API** (`PhysicsEngine`, `PhysicsWorld`, `PhysicsBody`, `PhysicsCollider`, `PhysicsJoint`, `PhysicsCharacter`): plain data in (`BodyDesc`, `ColliderDesc`, `Shapes`), interfaces out; meters, kilograms, seconds, y up.
- **`ScenePhysics`**: `add(node, desc)`, `addCharacter(node, desc)`, `remove(node)`, `teleport`, `bodyOf`, `nodeOf`, `entityOf`; `step(dt)` and `sync(alpha)`, or `install(scheduler)`.
- **`PhysicsDebugView`**, and `drawWorld` / `DebugLines` to draw the lines elsewhere.
