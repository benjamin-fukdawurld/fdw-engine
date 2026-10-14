---
title: Scene graph
description: The scene, its ECS core, its transforms and invalidation, its indices, and how the renderer draws it.
sidebar:
  order: 9
---

`@fdw/engine-scene` gives the engine a scene: entities in a hierarchy, with
transforms, drawn by the `Renderer` as a source, and answering spatial
queries. Its core is an **ECS**, with **nodes** as a façade.

## Two ways in

| Way         | For                                                        | Looks like                                  |
| ----------- | ---------------------------------------------------------- | ------------------------------------------- |
| **Nodes**   | Editors, CAD, BIM, games with a few hundred moving objects | `player.transform.position = { x: 2 }`      |
| **Systems** | Thousands of objects updated each frame                    | `data[e * stride + position] += speed * dt` |

Both work on the same data: a node is a handle on an entity.

## Nodes

```ts
const scene = new Scene();
const player = scene.root
  .add({ name: 'player', position: { y: 1 } })
  .setMesh(body, skin);
const lamp = player
  .add({ position: { y: 1.5 } })
  .setLight(new SpotLight({ castShadow: true }));
const eye = player.add({ position: { y: 12, z: 6 } }).setCamera(camera);
```

| Member                                           | Does                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `transform`                                      | A `Transform`, relative to the parent                                    |
| `worldMatrix`, `worldPosition`                   | Up to date when read                                                     |
| `parent`, `children`, `add()`, `remove()`        | The hierarchy; `add(node)` moves a node under this one                   |
| `setMesh()`, `setLight()`, `setCamera()`         | Attach a mesh and a material, a light, a camera                          |
| `attach(component, values)`, `has()`, `detach()` | Components of your own                                                   |
| `visible`                                        | Hidden nodes are not drawn, nor their descendants                        |
| `layers`                                         | A 32-bit mask: a view only sees the nodes whose layers intersect its own |
| `static`, `occluder`                             | See below                                                                |
| `name`, `id`, `traverse()`                       | `scene.find(name)` finds a node                                          |

A node whose entity was removed throws when used: `node.alive` tells.

### Many nodes at once

A level, a city, a CAD assembly: thousands of nodes alike, created at
once. `scene.createBatch()` creates them without a node nor an object per
entity — the transforms come from flat arrays, the components are written
column by column:

```ts
const walls = scene.createBatch({
  count: 2400,
  parent: level.entity, // the root by default
  positions, // x, y, z per wall: a Float32Array of 3 × 2400
  scales, // optional, as rotations (x, y, z, w per entity)
  mesh: cube,
  material: stone,
  static: true,
  occluder: true,
});
scene.node(walls[0]).attach(Solid); // a node when you need one
```

It returns the entities, in the order of the arrays; `scene.node(entity)`
gives the node of one of them. The other options are those of a node
(`name`, `layers`, `visible`, `castShadow`).

## Transforms and invalidation

The transforms of a scene are blocks of its `TransformPool`
(`scene.transforms`), indexed by entity: local values, world matrix,
normal matrix. `node.transform` is a `Transform` on the block of its entity,
the same class as everywhere in the engine.

Nothing has to be updated by hand:

1. Changing a transform (or moving a node, hiding it) **invalidates** its
   branch: the world matrices below it are stale. Invalidating the same
   node ten times in a frame costs once.
2. A world matrix is **recomputed when read**, and those of its stale
   ancestors first.
3. Every query of the scene — the rendering, a raycast — first applies the
   pending changes (`scene.flush()`): world matrices, bounds, spatial
   indices, the lights and cameras following nodes.

The normal matrix is computed later still, only for the objects drawn.

## Static nodes and occluders

- A **static** node does not move. The scene computes it once, and indexes
  all the static nodes at once in an index of their own, built top down.
  Moving one stays possible, at a cost; the scene warns once.
- An **occluder** (a wall, a building) is a node that hides others.
  `scene.occluders()` lists them. The [occlusion culling](#occlusion-culling)
  does not need them: every opaque object drawn hides what is behind it.

## The scene as a source

```ts
renderer.render({ source: scene, camera, surface, layers: 0b01 });
```

For each view — the camera, each shadow map — the renderer asks the scene
what is in its frustum. The scene answers from its two loose octrees,
static and dynamic, without testing every node. A camera query also records
on each node the last query that kept it (`NodeState.lastVisible`), and
passes through `scene.occlusion` when one is set: a stage of your own
(a precomputed visibility, portals), applied to the camera queries only,
never to the shadow casters.

## Occlusion culling

What the frustum keeps can still be hidden by what is in front of it: from
a street, the first buildings hide almost all the others. An
`OcclusionCulling` (from `@fdw/engine-occlusion`) given to the scene passes
leaves them out:

```ts
const occlusion = new OcclusionCulling();
renderer.render({ source: scene, camera, surface, occlusion });
```

After the opaque objects, full screen passes reduce the depth buffer to a
pyramid and test the box of every object the frustum kept against it; the
results are read back without waiting, and the objects found hidden are
left out one to three frames later, until a test finds them visible again.
It works on every backend (no compute shaders needed), for any source. The
[tutorial](/fdw-engine/tutorials/occlusion-culling/) shows it on a city.

| Option       | Default | Role                                                                                                 |
| ------------ | ------- | ---------------------------------------------------------------------------------------------------- |
| `margin`     | 0.001   | How much farther, relatively, a box must be than the depth in front of it to be hidden               |
| `motion`     | 2       | The boxes grow by the distance the camera moved since the last frame, times this: fewer late objects |
| `maxPending` | 2       | Results awaited at most: no new test while they are                                                  |

- One per view (camera): it remembers what the tests of its view found.
- `renderer.stats.get(name).occluded` counts what it left out;
  `occlusion.isHidden(item)` says what the latest results found of an item.
- The shadow casters are never left out; nor are the items without bounds.
- Not with multisampling yet (`samples: 1`): it reads the depth.
- In a graph of your own, the graph needs the size of the frame
  (`new RenderGraph({ size })`).

## Queries

| Query                                        | Returns                                  |
| -------------------------------------------- | ---------------------------------------- |
| `scene.raycast(ray, visit, options, max)`    | The nodes the ray hits, nearest first    |
| `scene.queryVolume(volume, visit, options)`  | The nodes intersecting any `Volume`      |
| `raycastEntities()`, `queryVolumeEntities()` | The same, with entities, for the systems |

They test the bounds of the meshes, then the `volume` given to `setMesh()`
when there is one. `options` filters by `layers`, and includes the hidden
nodes with `hidden: true`. `visit` returns false to stop.

## The ECS core

The scene is built on a `World`, usable on its own:

```ts
const world = scene.world;
const Velocity = world.defineComponent('velocity', {
  x: 'f32',
  y: 'f32',
  z: 'f32',
});
const Path = world.defineComponent('path', { points: 'ref', speed: 'f32' });

world.add(enemy.entity, Velocity, { x: 1 });

const moving = world.query(Velocity, not(Path));
function move(dt: number) {
  const { data } = scene.transforms;
  const { stride, position } = TransformLayout;
  for (const e of moving) {
    data[e * stride + position] += Velocity.x[e] * dt;
    scene.transforms.touch(e);
  }
}
```

- **Entities** are numbers, indices in the columns. A destroyed index is
  reused later; its generation changes, which the nodes check.
- **Components** have a schema of typed fields — `f32`, `f64`, `i8`… `u32`,
  `ref` for an object, `['f32', 3]` for a vector. Each field is a **column**:
  a typed array indexed by entity (`Velocity.x[e]`). The columns are
  replaced when the world grows: read them where they are used.
- **Queries** (`world.query(A, B, not(C))`) stay up to date as components
  are added and removed. `entities` and `count` walk them fastest; remove
  components while walking backwards.
- **Listeners**: `world.onAdded()`, `world.onRemoved()`.
- **Systems** are plain functions: the core imposes no scheduler.

The components of the scene, for the systems: `Hierarchy` (parent, first
child, siblings), `NodeState` (flags, layers, last visible, name),
`MeshRenderer` (mesh, material, `noShadow`, volume, world bounds — the
bounds table of the GPU culling to come), `Light`, `CameraView`. Their flags
are 0 by default: `noShadow` rather than `castShadow`.

## Other scenes

`SceneNode` and `SceneGraph` describe a scene independently of this one,
and the renderer only knows `RenderSource`. A scene of CAD instances, or
the ECS of a game engine, can be drawn by the renderer by implementing
`RenderSource`:

```ts
interface RenderSource {
  query(
    frustum: Frustum,
    layers: number,
    visit: (item: Renderable) => void,
    view: 'camera' | 'shadow'
  ): void;
  lights?(): Iterable<BaseLight>;
  bounds?(out: Aabb): Aabb;
}
```

A list of items is a source too: `render({ items })` tests each item
against the frustum.

## Costs

On 10 000 nodes of which 1000 are visible: a camera query takes about
0.06 ms, moving 1000 nodes then querying 0.65 ms, a frame of the renderer
about 1 ms (against 18 ms without culling). Creating 100 000 static nodes
and indexing them takes about 0.38 s with nodes, 0.24 s with
`createBatch()`; most of what remains is the world matrices, the bounds
and the octree.

The objects sharing a mesh and a material are drawn as instances of one
draw (see [Object data and instancing](/fdw-engine/guides/backends-and-surfaces/#object-data-and-instancing)):
step 1 of the maze game, about 3700 objects drawn per frame with their
shadows, runs at about 170 frames per second on Vulkan (about 89 before
the object table and instancing) and 120 on Dawn (42 before the object
table).
