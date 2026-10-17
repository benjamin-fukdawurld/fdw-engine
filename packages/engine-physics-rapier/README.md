# @fdw/engine-physics-rapier

The abstract physics API of `@fdw/engine-physics` on [Rapier](https://rapier.rs) (Apache-2.0), compiled to WebAssembly: the same module in the browser and in Node (the native demos), inlined in the package (`@dimforge/rapier3d-compat`), nothing to serve. See [design/p7b-physics.md](../../design/p7b-physics.md) (in French) and the [physics guide](https://benjamin-fukdawurld.github.io/fdw-engine/guides/physics/).

```ts
import { createRapierPhysics } from '@fdw/engine-physics-rapier';

const engine = await createRapierPhysics(); // loads the module, once
const world = engine.createWorld({ gravity: { x: 0, y: -9.81, z: 0 } });
```

- The objects of Rapier stay reachable: `world.raw`, `body.raw`, `collider.raw`, `joint.raw`, `character.raw`.
- The queries see the world as of the last step (Rapier updates its broad phase in `step`).
- `RapierPhysics.bench.ts`: the cost of a step, 1000 boxes falling, with and without `ScenePhysics`.
