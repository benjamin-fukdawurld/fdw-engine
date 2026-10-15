# @fdw/engine-scene

The scene of FdwEngine: entities in a hierarchy, drawn by the `Renderer` as a `RenderSource`, with spatial queries. Its core is an ECS, with nodes as a façade. See [design/scenegraph.md](../../design/scenegraph.md) (in French).

## The ECS core

```ts
import { not, World } from '@fdw/engine-scene';

const world = new World();
const Velocity = world.defineComponent('velocity', {
  x: 'f32',
  y: 'f32',
  z: 'f32',
});
const Path = world.defineComponent('path', { points: 'ref', speed: 'f32' });

const entity = world.create();
world.add(entity, Velocity, { x: 1 });

// A system: a function walking a query.
const moving = world.query(Velocity, not(Path));
for (const entity of moving) {
  Velocity.y[entity] -= 9.81 * dt;
}
```

- **Entities** are indices in the columns. A destroyed index is reused later; its `generation` then changes.
- **Components** have a schema of typed fields (`f32`, `f64`, `i8`… `u32`, `ref` for objects, `['f32', 3]` for vectors): each field is a column indexed by entity. Columns are replaced when the world grows: read them where they are used.
- **Queries** (`world.query(A, B, not(C))`) are kept up to date as components are added and removed; `entities` and `count` are the fastest way to walk them.
- **Listeners**: `world.onAdded(component, listener)`, `world.onRemoved(component, listener)`.

## The scheduler

```ts
import { Scheduler } from '@fdw/engine-scene';

const scheduler = new Scheduler({ step: 1 / 60 });
scheduler.add('input', () => input.update(), { phase: 'begin' });
scheduler.add('move', move, { phase: 'fixed' });
scheduler.add('gravity', gravity, { phase: 'fixed', before: ['move'] });
scheduler.add('draw', () => draw(scheduler.alpha));
scheduler.add('render', render, { phase: 'render' });
onFrame((dt) => scheduler.update(dt));
```

- **Phases**: `begin` (once), `fixed` (at each fixed step, `dt` is the step), `update` (once, the default), `render` (once, last).
- **Order**: the order of addition in a phase, refined by `before` and `after`; a cycle makes `add()` throw.
- **Fixed step**: at most `maxSteps` per frame; `steps`, `time`, `alpha` to draw between the last two steps. `FixedStep` alone for a loop without a scheduler.
- **Control**: `paused`, `timeScale`, `step()` (the `fixed` phase only), `system.enabled`, `remove(name)`.

## The scene

```ts
import { Scene } from '@fdw/engine-scene';

const scene = new Scene();
const player = scene.root.add({ name: 'player', position: { y: 1 } });
player.setMesh(body, skin);
player
  .add({ position: { y: 1.5 } })
  .setLight(new SpotLight({ castShadow: true }));
player.add({ position: { y: 12, z: 6 } }).setCamera(camera);
scene.root.add({ static: true }).setMesh(walls, stone);

// Each frame: the logic, then the rendering. Nothing to update by hand.
player.transform.position = { x: player.transform.position.x + speed * dt };
renderer.render({ source: scene, camera, surface });
```

- **Nodes** are handles on entities: `transform` (partial values), `worldMatrix`, `parent`, `children`, `add`, `remove`, `attach(component, values)`, `setMesh`, `setLight`, `setCamera`, `visible`, `layers`, `static`, `occluder`. A node whose entity was removed throws when used.
- **Transforms**: in `scene.transforms`, a `TransformPool` indexed by entity (`@fdw/engine-core`). `node.transform` is a `Transform` on the block of the entity. A system writes the local values of entity `e` at `e * TransformLayout.stride` of `scene.transforms.data`, then calls `scene.transforms.touch(e)`.
- **Components of the scene**, for systems: `Hierarchy`, `NodeState`, `MeshRenderer`, `Light`, `CameraView`.
- **Invalidation**: a change marks the branch stale; a world matrix is recomputed when read; every query (the rendering, a raycast) first applies the pending changes (`scene.flush()`).
- **Indices**: the renderers are in two loose octrees (`@fdw/engine-geometry`), static and dynamic. Static nodes are indexed at once, at the next flush.
- **Queries**: `scene.raycast(ray, visit)`, nearest first; `scene.queryVolume(volume, visit)`, with any `Volume`; options `layers` and `hidden`. Entity versions (`raycastEntities`, `queryVolumeEntities`) for the systems.
- **Occlusion**: `scene.occlusion`, a stage applied to the camera queries only; `NodeState.lastVisible` remembers the last camera query that kept a node; `scene.occluders()` lists the occluders.

`SceneNode` and `SceneGraph` describe a scene independently of this implementation.
