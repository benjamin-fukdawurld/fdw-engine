---
title: Physics
description: The abstract physics API, its binding to the scene and the fixed step, the debug view, Rapier, and how to plug another physics engine.
sidebar:
  order: 13
---

The engine does not write its own physics. It defines what it asks of a
physics engine, and plugs one behind it:

- `@fdw/engine-physics`: the **abstract API** (worlds, bodies, colliders,
  shapes, joints, queries, events, character controllers), its **binding
  to the scene** (`ScenePhysics`: the bodies as components, the simulation
  in the fixed step), the **debug view**, and a character controller
  against the volumes of a scene (`SceneCharacter`). It depends on no
  physics engine.
- `@fdw/engine-physics-rapier`: the API on [Rapier](https://rapier.rs),
  compiled to WebAssembly: the same module in the browser and in Node (the
  native demos).
- `@fdw/engine-ragdoll`: ragdolls on the skeletons of the animation,
  against the API.

The tutorial [Physics](/fdw-engine/tutorials/physics/) puts them together;
[Navigation](/fdw-engine/tutorials/navigation/) walks characters without an
engine, [Ragdolls](/fdw-engine/tutorials/ragdolls/) knocks them down.

## The API

| Interface          | What it is                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `PhysicsEngine`    | An implementation: `name`, `createWorld({ gravity })`                                    |
| `PhysicsWorld`     | The bodies, joints and characters; `step(dt)`, `events`, `contacts()`, the queries       |
| `PhysicsBody`      | `type`, the pose, the velocities, impulses and forces, `mass`, `sleeping`, its colliders |
| `PhysicsCollider`  | A shape on a body: `sensor`, `friction`, `restitution`, its pose in the world            |
| `PhysicsJoint`     | Two bodies joined: `fixed`, `ball`, `hinge`, `slider`; limits and a motor                |
| `PhysicsCharacter` | A kinematic body moved by `move()`: slides, climbs steps and slopes, stays on the ground |

The units are meters, kilograms and seconds; y is up. Vectors are
`{ x, y, z }`, rotations quaternions `{ x, y, z, w }`.

### Bodies

```ts
const body = world.createBody({
  type: 'dynamic', // 'static' | 'dynamic' | 'kinematic'
  position: { x: 0, y: 3, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  linearVelocity: { x: 1 },
  gravityScale: 1,
  linearDamping: 0,
  ccd: false, // continuous collision detection, for the fast and small
  canSleep: true,
  lockRotations: false,
  colliders: [{ shape: Shapes.sphere(0.5) }],
});
```

| Member                                | Use                                                                          |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| `readPose(out, offset)`               | The pose in 7 floats (position, rotation), without allocating: hot loops     |
| `position`, `rotation`                | The pose, as objects                                                         |
| `setPose(position, rotation)`         | A teleport: no velocity, no push                                             |
| `moveTo(position, rotation)`          | Kinematic: where the next step takes it, pushing the dynamic bodies          |
| `linearVelocity`, `angularVelocity`   | Read and written                                                             |
| `applyImpulse(impulse, point?)`       | A change of momentum (N·s), at a point of the world or at the center of mass |
| `applyForce(force, point?)`           | A force (N) during the next step                                             |
| `applyTorqueImpulse(impulse)`         | A change of angular momentum                                                 |
| `mass`, `sleeping`, `wakeUp()`        | A body at rest falls asleep: it costs nothing until something wakes it       |
| `addCollider(desc)`, `removeCollider` | The colliders after the creation                                             |

### Colliders and shapes

```ts
{
  shape: Shapes.capsule(0.5, 0.3),
  position: { y: 0.8 }, // relative to the body
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  density: 1, // kg/m³: the mass of a dynamic body
  material: { friction: 0.5, restitution: 0, frictionCombine: 'average' },
  groups: 0b0010, // in group 2
  mask: 0b1101, // collides with groups 1, 3, 4
  sensor: false,
  events: false, // reports its contacts in world.events
}
```

| Shape                                      | Notes                                                                       |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| `Shapes.sphere(radius)`                    |                                                                             |
| `Shapes.box(hx, hy?, hz?)`                 | Half extents; one value: a cube                                             |
| `Shapes.capsule(halfHeight, radius)`       | Along y; `2 × (halfHeight + radius)` tall                                   |
| `Shapes.cylinder(halfHeight, radius)`      | Along y                                                                     |
| `Shapes.convex(points, indices?)`          | The hull of the points; with indices, the points and triangles are the hull |
| `Shapes.mesh(vertices, indices)`           | Hollow triangles: for the static bodies (a level)                           |
| `Shapes.heightfield(rows, columns, h, sz)` | `rows × columns` heights, row after row; rows along z, columns along x      |

The shapes are plain data: the debug view draws them, another engine
translates them. They are not scaled by the nodes.

Two colliders collide when each is in the `mask` of the other (16 groups;
by default, in group 1 and colliding with all). The coefficients of two
colliders in contact combine by their rules (`average`, `min`, `max`,
`multiply`).

### Joints

```ts
world.createJoint({
  type: 'hinge', // 'fixed' | 'ball' | 'hinge' | 'slider'
  bodyA: frame,
  bodyB: door,
  anchorA: { x: 0.5 }, // in the space of each body
  anchorB: { x: -0.5 },
  axis: { x: 0, y: 1, z: 0 }, // hinge and slider
  limits: [0, Math.PI / 2], // radians, or meters for a slider
  motor: { velocity: 1 }, // or { target, stiffness, damping }: a spring
  collide: false,
});
```

A `fixed` joint welds the bodies as they are when it is created. Removing a
body removes its joints.

### Queries

| Query                                                | Result                                                 |
| ---------------------------------------------------- | ------------------------------------------------------ |
| `raycast(origin, direction, maxDistance, filter?)`   | The first hit: collider, body, distance, point, normal |
| `raycastAll(origin, direction, max, visit, filter?)` | Every hit, in no order; `visit` returns false to stop  |
| `shapeCast(shape, position, rotation, dir, max, f?)` | Where a moving shape first touches                     |
| `overlap(shape, position, rotation, visit, filter?)` | The colliders inside a shape                           |

The directions are normalized. A `QueryFilter` keeps some colliders:
`mask` (groups), `exclude` (a body: the one asking), `skip` (types of
bodies), `sensors` (seen or not, default not), `predicate`. The queries see
the world as of the **last step**: a body created or moved since is seen
after the next one.

### Events

After each step, `world.events` lists the pairs of colliders that started
(`begin`) or stopped (`end`) touching: those of the sensors (`sensor:
true`: an entry, an exit), and those of the colliders with `events: true`.
`world.contacts(visit)` gives the points of the contacts touching now, with
their normals and depths: for the debug views.

### Character controllers

```ts
const character = world.createCharacter({
  shape: Shapes.capsule(0.5, 0.3),
  position: { y: 1 },
  offset: 0.02, // the gap kept to the surfaces
  maxSlope: Math.PI / 4,
  stepHeight: 0.3,
  snapToGround: 0.3,
  pushBodies: true,
});

const { movement, grounded, collisions } = character.move({ x, y, z });
```

`move` takes the movement of this step, gravity included, and returns what
was done of it; the body gets there at the next step. One move per step.

`PhysicsCharacter` is a `CharacterController`: the interface of what moves
a character (`move`, `grounded`), whatever is behind.

### A character without an engine

```ts
import { SceneCharacter } from '@fdw/engine-physics';

const character = new SceneCharacter(scene, {
  radius: 0.3,
  height: 1.8, // from end to end
  position: { y: 0.92 }, // the center of the capsule
  offset: 0.02,
  maxSlope: Math.PI / 4,
  stepHeight: 0.3,
  snapToGround: 0.3,
  ground: (x, z) => terrainHeight(x, z), // optional
  ignore: (entity) => entity === hero.entity,
  layers: 1, // the layers of the scene it collides with
});

const { movement, grounded, collisions } = character.move({ x, y, z });
character.position; // the center of the capsule
character.teleport({ x: 0, y: 5 });
```

The other `CharacterController`: a vertical capsule against the **volumes
of the renderers of a scene**, without a physics engine. The obstacles are
the volume given to `setMesh` (`Aabb`, `Obb`, `Sphere`, `Capsule`: their
signed distance is exact) or the bounds of the mesh (any other volume
stands for its bounds); and a ground function, for a terrain. The move:

1. **In small steps** (half the radius), each followed by passes pushing
   the capsule out of what it overlaps, along the normal of the surface:
   it slides along the walls. The point of its segment closest to each
   volume is found by a golden-section search of the signed distance
   (`signedDistance` of `@fdw/engine-geometry`).
2. **The ground**: a surface no steeper than `maxSlope` pushes straight
   up — no sliding down a slope while standing — and makes it `grounded`.
3. **The steps**: blocked while walking on the ground, it tries the move
   again `stepHeight` higher, then down: kept if it lands on walkable
   ground (checked by a ray under its axis: a steep slope is no step) and
   went further.
4. **Snapped to the ground**: grounded before, not after, not going up: a
   probe down by `snapToGround` keeps it on a slope or a step down.

`collisions` lists the entities touched. It pushes nothing.

## The scene and the fixed step

`ScenePhysics` makes the bodies components of the entities of a
[scene](/fdw-engine/guides/scene-graph/):

```ts
const physics = new ScenePhysics(scene, world);
physics.add(node, { type: 'dynamic', colliders: [{ shape }] });
physics.addCharacter(node, { shape: Shapes.capsule(0.5, 0.3) });
physics.install(scheduler); // systems physics (fixed) and physics:sync (update)
```

The body is created at the pose of the node in the world. Who moves whom
depends on `follow`:

| `follow` | Default for | At each step                                                |
| -------- | ----------- | ----------------------------------------------------------- |
| `body`   | `dynamic`   | The node follows the body, drawn between the last two steps |
| `node`   | `kinematic` | The body is moved to the node (`moveTo`): animate the node  |
| `none`   | `static`    | Nothing                                                     |

- A node following its body is **under the root**: its local transform is
  its pose in the world.
- The component `physics.Body` holds the poses of the last two steps; the
  nodes are written between them by `alpha` (`physics.interpolate =
false` turns it off). A body at rest stops writing its node.
- `physics.teleport(node, position, rotation)` moves a body and its node
  without drawing the way between.
- `bodyOf(node)`, `characterOf(node)`, `entityOf(body or collider)`,
  `nodeOf(body or collider)`: from one side to the other — the hits of the
  queries and the events give colliders.
- Removing a node removes its body; `physics.remove(node)` the body alone;
  `physics.destroy()` all the bodies of the scene.

## The debug view

`PhysicsDebugView(scene, world, options)` draws the world in lines, by a
node of the scene: the shapes (colored by the state of their body), the
contact points with their normals, the joints, and the rays given to
`debug.ray(origin, direction, maxDistance, hit)` for `rayLife` seconds.
`update(dt)` once per frame; `enabled` turns it off. The options choose
what is drawn (`shapes`, `contacts`, `joints`) and the colors.

The lines come from `drawWorld(world, lines)`, written against the abstract
API, into a `DebugLines` (positions and colors): a tool can draw them its
own way. The view draws them as a mesh of `topology: 'line-list'` (a field
of `MeshDescription`, on the three backends), unlit, without shadow.

## Ragdolls

```ts
import { Ragdoll } from '@fdw/engine-ragdoll';

const ragdoll = new Ragdoll(world, skeleton, {
  bones: [
    { joint: 'hips', to: 'spine', radius: 0.13 },
    {
      joint: 'lowerLeg.L',
      to: 'foot.L',
      radius: 0.06,
      link: 'hinge',
      limits: [0, 2.4],
    },
    // …
  ],
  groups: 2,
  mask: 1,
});
ragdoll.activate(pose, nodeOfSkeleton.worldMatrix, velocity);
ragdoll.readPose(out); // each frame, after the step
ragdoll.deactivate();
```

`@fdw/engine-ragdoll` puts dynamic bodies on the bones of a skeleton of
`@fdw/engine-animation`, against the abstract API:

- A **bone** is a capsule from its joint to the joint `to`, or a sphere on
  its joint; `density` gives its mass (1000 kg/m³ by default).
- Each body hangs on the body of its **nearest ancestor** with one: a
  `ball` joint at the joint, or a `hinge` around `axis` (in the space of
  the joint, x by default) within `limits` (radians, around the angle at
  the activation).
- All the bodies are created **turned as the node** of the skeleton, the
  rotation of each joint kept as an offset: a hinge axis is the same in
  the two bodies it links, as the API asks.
- `activate(pose, matrix, velocity)` creates the bodies and joints at the
  pose (the world matrix of the parent of the root joint), moving at
  `velocity`; `deactivate` removes them. `bodyOf(joint)` gives a body, to
  push one limb.
- `readPose(out)` writes the local transforms: the joints with a body
  where it is, the others as at the activation under their parent;
  relative to the node at the activation.

## Rapier

```ts
import { createRapierPhysics } from '@fdw/engine-physics-rapier';
const engine = await createRapierPhysics();
```

`createRapierPhysics()` loads the WebAssembly module once (it is inlined
in the package: no file to serve), in the browser as in Node. The objects
of Rapier stay reachable (`world.raw`, `body.raw`, `joint.raw`,
`character.raw`) for what the API does not cover yet.

On one machine, Rapier is deterministic: the same steps give the same
world. 1000 boxes falling in a pile cost about 3 ms per step while they
fall and collide, all awake, and 1 ms on average over ten seconds, as they
come to rest; `ScenePhysics` adds about 0.6 ms for their nodes (Node 24,
one thread).

## Another engine

An implementation is a `PhysicsEngine` whose `createWorld` returns a
`PhysicsWorld`: its bodies, colliders, joints and characters implement the
interfaces above. `ScenePhysics`, the debug view and the code of a game
then work unchanged. What to watch for:

- `readPose` writes 7 floats and allocates nothing: the binding calls it
  for every moving body at every step.
- `applyForce` lasts one step: an engine keeping its forces resets them
  after `step`.
- `events` is the list of the last step; `contacts` is for debugging and
  may be slow.
- The shapes are plain data, translated at the creation of a collider.
