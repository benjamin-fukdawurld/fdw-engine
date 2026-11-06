# @fdw/engine-navigation

Navigation for FdwEngine: navigation meshes built from the volumes of a scene (or from triangles, or loaded), the paths found on them — A\* over the polygons, then the funnel algorithm through their portals — and the agents that follow them. Pure TypeScript, on the volumes of `@fdw/engine-geometry` and the queries of `@fdw/engine-scene`. See [design/p25-gameplay.md](../../design/p25-gameplay.md) (in French), the [tutorial](https://benjamin-fukdawurld.github.io/fdw-engine/tutorials/navigation/) and the [guide](https://benjamin-fukdawurld.github.io/fdw-engine/guides/navigation/).

```ts
import { Aabb } from '@fdw/engine-geometry';
import { buildNavMesh, NavAgent, sceneVolumes } from '@fdw/engine-navigation';

const navMesh = buildNavMesh({
  bounds: new Aabb([-20, -1, -20], [20, 5, 20]),
  volumes: sceneVolumes(scene),
  agentRadius: 0.4,
});
const path = navMesh.findPath(start, end); // the corners, or undefined

const agent = new NavAgent(navMesh, { speed: 3 });
agent.setDestination(position, target);
const step = agent.update(position, dt); // give it to a character controller
```

## Public API

| Export         | Description                                                                                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NavMesh`      | Convex polygons linked by portals: `findPath(start, end, { partial })`, `closestPoint`, `neighbors`, `lines()` (debug), `toData()`; `NavMesh.fromTriangles(...)` |
| `buildNavMesh` | A navigation mesh of the volumes of a region: columns of floors with room above them, linked within a step, eroded by the radius of the agent, in rectangles     |
| `TiledNavMesh` | The same by tiles: obstacles carved while the game runs (`addObstacle`, `moveObstacle`, `removeObstacle`), the tiles they touch built again at `update()`        |
| `sceneVolumes` | The volumes of the renderers of a scene in the world (the volume of `setMesh`, or the bounds of the mesh)                                                        |
| `NavAgent`     | Follows the paths: the movement of each step toward the next corner, at its speed; a new path when pushed away, or given a new mesh                              |
| `NavCrowd`     | Agents making way for each other: optimal reciprocal collision avoidance (ORCA), the velocity of each closest to the one it would like                           |
