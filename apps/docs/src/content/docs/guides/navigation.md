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
| `TiledNavMesh` | The same by tiles, built again alone: obstacles placed while it runs    |
| `sceneVolumes` | The volumes of the renderers of a scene, in the world                   |
| `NavAgent`     | Follows the paths: the movement of each step toward the next corner     |
| `NavCrowd`     | Agents making way for each other: reciprocal avoidance (ORCA)           |

The tutorial [Crowds and obstacles](/fdw-engine/tutorials/crowds/) shows
the tiles, the obstacles and the crowd.

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
  heightTolerance: 0.01, // more on a terrain
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
5. **Polygons.** The floors are gathered in rectangles, along x then z,
   as long as they stay within `heightTolerance` of the first (1 cm by
   default: flat floors); each rectangle is a polygon at their mean height,
   linked to its neighbors by a **portal**: the part of their common edge
   where their floors are linked. On a terrain, a tolerance of a few tens of
   centimeters makes rectangles of meters instead of a polygon per cell:
   the paths are laid on the ground from above, their heights within the
   tolerance.

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

## Tiles and obstacles

```ts
const tiles = new TiledNavMesh({ ...options, tileCells: 64 });
const crate = tiles.addObstacle(new Aabb([2, 0, 2], [3, 1, 3]));
tiles.moveObstacle(crate, volume);
tiles.removeObstacle(crate);
tiles.invalidate(box); // the volumes changed there: read again
if (tiles.update(maxTiles)) agent.navMesh = tiles.navMesh;
```

- **Tiles.** The columns are cut in tiles of `tileCells` × `tileCells`
  cells, each built by the steps above from the solids of the tile and of
  a margin of `agentRadius / cellSize + 2` cells around it: its floors
  are eroded as in a mesh built at once (the sides of the margin are not
  edges). Its rectangles stay within it. A floor of a side linked to a
  floor across it is noted with the heights of both; when the tiles are
  gathered, two such notes facing each other make a portal.
- **Obstacles** carve: a floor is dropped when an obstacle fills the
  column from a step below it to the height of the agent above it, before
  the erosion. An obstacle is not a floor: nothing walks on top of it.
- **Updates.** An obstacle added, moved or removed, or `invalidate(box)`,
  marks the tiles within its bounds widened by the radius of the agents;
  `update` builds them again (at most `maxTiles`), and gathers every tile
  in a new `NavMesh` (`version` counts them). The polygons are numbered
  anew: a `NavAgent` given the new mesh (`agent.navMesh = …`) finds a new
  path at its next `update`.

The cost of a tile is that of its columns, margin included: a tile of
64 × 64 cells builds in a few milliseconds.

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
the controller's. Given another mesh (`agent.navMesh`), it finds a new
path at its next `update`.

## Crowds

```ts
const crowd = new NavCrowd({
  timeHorizon: 1.5, // seconds ahead
  neighborDistance: 6,
  maxNeighbors: 8,
});
const member = crowd.add({ radius: 0.4, maxSpeed: 3, position });
member.moveTo(x, z); // where it is
member.prefer(vx, vz); // the velocity it would like
crowd.update(dt); // every member.velocity, at once
member.avoids = false; // goes its way; the others make way
crowd.remove(member);
```

**Optimal reciprocal collision avoidance** (ORCA, van den Berg, Guy, Lin
and Manocha, 2011), as the RVO2 library does it, on the ground:

- For each neighbor within `neighborDistance` (the `maxNeighbors`
  closest), the velocities that would run into it within `timeHorizon`
  form a cone cut by a disk; the agent takes half of the change that leaves
  it (all of it facing one that does not avoid): a **half-plane** of
  velocities allowed. Two agents already overlapping part within the step.
- The velocity kept is the closest to the preferred one within `maxSpeed`
  and every half-plane: a linear program in two dimensions, the
  half-planes added one at a time. When none fits them all, the velocity
  that breaks the worst of them the least.
- `update` computes every velocity from the positions and the velocities
  of the last update, then writes them: the order of the agents does not
  matter.

The crowd knows no walls: the paths keep away from them, and the character
controllers collide. Its cost grows with the agents and their neighbors:
tens of agents take a fraction of a millisecond.

## Limits

- No off-mesh links (a jump, a ladder) yet.
- The crowd avoids the agents, not the walls: a crowd pressed against a
  wall relies on the paths and the controllers.
- The rectangles are not triangulated regions as Recast makes: an
  irregular level makes more polygons than needed.
