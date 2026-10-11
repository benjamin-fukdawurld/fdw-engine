---
title: Geometry
description: Volumes, intersections, rays and spatial indices, for culling, picking and physics.
sidebar:
  order: 8
---

`@fdw/engine-geometry` is pure TypeScript, without dependency: the renderer
culls with it, the scene indexes its nodes with it, and an application, a
physics engine or a tool can use it on their own.

## Volumes

Every volume implements `Volume`:

| Member                 | Does                                                                |
| ---------------------- | ------------------------------------------------------------------- |
| `kind`                 | Its type (`'aabb'`, `'sphere'`…), for the fast intersection tests   |
| `bounds(out?)`         | A box containing it: what the spatial indices store                 |
| `transform(matrix)`    | The smallest volume of the same kind containing it, transformed     |
| `containsPoint(point)` | Whether a point is inside                                           |
| `raycast(ray)`         | The distance along a ray to the volume, 0 from inside, or undefined |

The engine gives these volumes:

| Volume    | Use                                                                                         |
| --------- | ------------------------------------------------------------------------------------------- |
| `Aabb`    | A box aligned on the axes: the indices, the culling                                         |
| `Sphere`  | Center and radius                                                                           |
| `Obb`     | A box oriented by three axes: the tight bounds of a turned object                           |
| `Capsule` | The points within a radius of a segment: characters                                         |
| `Frustum` | Six planes from a view-projection matrix (`Frustum.fromMatrix()`), the volume a camera sees |

A `Ray` (an origin, a unit direction) is not a volume, but every query
takes one. Vectors are `[x, y, z]` arrays; matrices are 4 × 4,
column-major. The functions called per object and per frame write into an
`out` argument: nothing is allocated in the hot loops.

## Your own volumes

A **convex** volume adds a support function: the point of the volume
farthest in a direction.

```ts
class Cylinder implements ConvexVolume {
  readonly kind = 'cylinder';
  constructor(
    readonly center: Vec3,
    readonly radius: number,
    readonly halfHeight: number
  ) {}

  support([dx, dy, dz]: ReadonlyVec3, out: Vec3): Vec3 {
    const horizontal = Math.hypot(dx, dz) || 1;
    return set(
      out,
      this.center[0] + (dx / horizontal) * this.radius,
      this.center[1] + (dy >= 0 ? this.halfHeight : -this.halfHeight),
      this.center[2] + (dz / horizontal) * this.radius
    );
  }
  // bounds(), transform(), containsPoint(), raycast()…
}
```

That is enough for `intersects()` to test it against any other convex
volume: it uses **GJK**, which only needs the support functions of the two
volumes. A physics engine would build on the same function (EPA, the next
step of GJK, gives the penetration and the contact normal).

## Intersections

```ts
intersects(
  new Capsule([0, 0, 0], [0, 2, 0], 0.5),
  new Obb([1, 1, 0], [0.6, 0.6, 0.6])
);
```

`intersects(a, b)` uses the test registered for the kinds of the two
volumes — box–box, sphere–sphere, sphere–box, capsule–capsule,
capsule–sphere — and GJK otherwise. A faster exact test for a pair of your
own kinds:

```ts
registerIntersection<Cylinder, Sphere>('cylinder', 'sphere', (cylinder, sphere) => …);
```

A volume without support function and without registered test throws an
explicit error.

The culling uses faster, conservative tests: `frustum.classifyAabb(box)`
says `outside`, `intersects` or `inside` (a spatial index then accepts a
whole cell without testing its items), `frustum.intersectsSphere()`. A box
near an edge of the frustum, but outside, can be reported as intersecting:
it is drawn for nothing, never missed.

## Spatial indices

A `SpatialIndex` stores items by their bounds, and answers queries:

```ts
const index = new Octree<Enemy>();
index.insert(enemy, enemy.bounds);
index.update(enemy, enemy.bounds); // it moved
index.queryFrustum(frustum, (enemy, inside) => …);
index.queryVolume(new Sphere(position, 10), (enemy) => …);
index.raycast(ray, (enemy, distance) => { … return false; }); // nearest first
```

It knows nothing of the items: nodes, entity ids, objects of the
application. Two implementations:

- `LinearIndex`: tests every item. The reference, and the right choice
  below a few hundred items.
- `Octree`: a **loose** octree. Each cell accepts the items that fit in its
  bounds grown by a factor 2: an item is stored in a single cell, as deep
  as its size allows, and an item that moves a little stays in its cell.
  Its root grows when an item is outside of it. `insertAll()` builds it top
  down for many items at once.

On 10 000 items, a frustum query takes about 0.06 ms, a nearest ray hit
7 µs, and moving 1000 items 0.09 ms.
