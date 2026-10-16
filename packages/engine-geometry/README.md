# @fdw/engine-geometry

Volumes, intersections and spatial queries of FdwEngine. Pure TypeScript, without dependency: the renderer culls with it, the scene graph indexes its objects with it, and a physics engine or a tool can use it on their own. See [design/scenegraph.md](../../design/scenegraph.md) (in French).

## Volumes

Every volume implements `Volume`: a `kind`, its `bounds()` (an `Aabb`), `transform(matrix)`, `containsPoint()` and `raycast()`. A `ConvexVolume` adds a support function, `support(direction, out)`: the point of the volume farthest in a direction.

| Volume    | Description                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------ |
| `Aabb`    | Box aligned on the axes: what the spatial indices store                                                                  |
| `Sphere`  | Center and radius                                                                                                        |
| `Obb`     | Box oriented by three orthonormal axes                                                                                   |
| `Capsule` | The points within a radius of a segment                                                                                  |
| `Frustum` | Six planes from a view-projection matrix (depth from 0 to 1); `classifyAabb()` gives `outside`, `intersects` or `inside` |
| `Ray`     | An origin and a unit direction, for the queries                                                                          |

`transformAabb(box, matrix, out)` bounds a transformed box without transforming its corners. The functions called per object and per frame write into an `out` argument: nothing is allocated in the hot loops.

## Intersections

```ts
import { Capsule, intersects, Obb } from '@fdw/engine-geometry';

intersects(
  new Capsule([0, 0, 0], [0, 2, 0], 0.5),
  new Obb([1, 1, 0], [0.6, 0.6, 0.6]),
);
```

`intersects(a, b)` uses the fast test registered for the kinds of the two volumes (box–box, sphere–sphere, sphere–box, capsule–capsule, capsule–sphere), and otherwise **GJK** when both are convex. A volume of the application only needs a support function to be tested against any other:

```ts
class Cylinder implements ConvexVolume {
  readonly kind = 'cylinder';
  support(direction, out) { /* the farthest point of the cylinder */ }
  // bounds, transform, containsPoint, raycast…
}

intersects(new Cylinder(…), new Sphere([0, 1, 0], 0.5)); // GJK
registerIntersection('cylinder', 'sphere', (cylinder, sphere) => …); // a faster exact test
```

A volume without support function and without registered test throws an explicit error.
