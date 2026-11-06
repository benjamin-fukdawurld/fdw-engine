---
title: Navigation
description: Navigation meshes built from the volumes of a scene or from triangles, the paths found on them (A* and the funnel), and the agents that follow them.
sidebar:
  order: 21
---

`@fdw/engine-navigation` finds where agents can walk, and the paths
between two points. Pure TypeScript, on the volumes of
`@fdw/engine-geometry` and the queries of `@fdw/engine-scene`; it moves
nothing itself: a [character controller](/fdw-engine/guides/physics/#a-character-without-an-engine)
does. The tutorial [Navigation](/fdw-engine/tutorials/navigation/) puts it
together.

| Export         | What                                                                    |
| -------------- | ----------------------------------------------------------------------- |
| `NavMesh`      | Convex polygons linked by portals: `findPath`, `closestPoint`, `toData` |
| `buildNavMesh` | A navigation mesh of the volumes of a region (and a ground function)    |
| `sceneVolumes` | The volumes of the renderers of a scene, in the world                   |
| `NavAgent`     | Follows the paths: the movement of each step toward the next corner     |

## Building from volumes

```ts
const navMesh = buildNavMesh({
  bounds: new Aabb([-50, -5, -50], [50, 20, 50]),
  volumes: sceneVolumes(scene, { filter: (node) => node.static }),
  ground: (x, z) => terrain.height(x, z), // optional
  cellSize: 0.25,
  agentRadius: 0.4,
  agentHeight: 1.8,
  maxClimb: 0.4,
  maxSlope: Math.PI / 4,
});
```

The steps, all on the CPU:

1. **Columns.** The region is cut in columns of `cellSize`. Each volume
   gives the vertical interval it fills in the columns it covers: its box
   for an `Aabb`, two rays (down and up) at the center of the column for
   the others — an oriented box makes a ramp, a sphere a dome. The ground
   function fills everything below it.
2. **Floors.** The intervals of a column are merged; the top of each is a
   **floor** when the next one starts at least `agentHeight` above it. A
   column has several floors under a bridge or a floor above.
3. **Links.** A floor is linked to the floor of each of its 4 neighbor
   columns whose height differs by `maxClimb` at most (or by `cellSize ×
tan(maxSlope)`, for a slope), with room for the agent on both. A floor
   steeper than `maxSlope` across its neighbors is dropped.
4. **Erosion.** The distance of each floor to the nearest edge (a floor
   missing a link) is spread through the links, straight and diagonal; the
   floors closer than `agentRadius` are dropped. The agents then keep away
   from the walls and the drops whatever their path, and the paths need no
   offset.
5. **Polygons.** The flat floors are gathered in rectangles, along x then
   z; each rectangle is a polygon, linked to its neighbors by a **portal**:
   the part of their common edge where their floors are linked.

The cost grows with the number of columns: 0.25 m cells over 100 × 100 m
are 160,000 columns. Build once, when the level loads, or offline
(`toData()`); a level that changes builds again.

The tops of the walls are floors too when an agent fits there: islands,
not linked to the rest. `findPath` does not reach them.

## Other sources

```ts
// The walkable triangles of a mesh: those no steeper than maxSlope.
const fromMesh = NavMesh.fromTriangles(positions, indices, { maxSlope });
// Saved, then loaded.
const data = navMesh.toData(); // plain JSON
const again = new NavMesh(data);
```

`fromTriangles` welds the vertices and links the triangles by their shared
edges. The triangles are walked as they are: they should keep away from
the walls by the radius of the agents. `NavMeshData` takes convex polygons
of any number of vertices, and `links` (portals) when the polygons do not
share their edges.

## Paths

```ts
const corners = navMesh.findPath(start, end, { partial: true, maxDistance: 2 });
const nearest = navMesh.closestPoint(point); // { polygon, point }
```

- **Locating.** The polygons are binned in x and z; `closestPoint` looks in
  rings of bins around the point, for the closest point of a polygon (in
  three dimensions: under a bridge, the floor nearest in height).
- **A\*** over the polygons: the path enters each polygon at a point of
  its portal, the one on the shortest way from the point it entered the
  previous polygon to the end (a golden-section search along the portal:
  large polygons do not mislead it as their middles would); the cost is
  the length of these segments, the heuristic the straight distance to the
  end.
- **The funnel** ("simple stupid funnel algorithm", Mikko Mononen): the
  corridor of polygons as a sequence of portals, the path pulled tight
  through them; its corners are ends of portals: the corners of the
  walkable area, at `agentRadius` from the walls.

## Agents

```ts
const agent = new NavAgent(navMesh, {
  speed: 3,
  tolerance: 0.1, // a corner within this is reached
  maxDeviation: 1, // a new path beyond this
});
agent.setDestination(position, target); // false: no path
const step = agent.update(position, dt); // horizontal movement of this step
agent.idle; // arrived, stopped, or no path
agent.remaining(position); // meters along the path
```

`update` spends `speed × dt` along the corners, passing those it reaches,
and never goes beyond the last one. The y of the movement is 0: gravity is
the controller's.

## Limits

- The navigation mesh is static: no obstacles carved at run time, no tiles
  rebuilt alone.
- No avoidance between agents: they cross each other (a controller of the
  physics pushes them apart).
- No off-mesh links (a jump, a ladder) yet.
