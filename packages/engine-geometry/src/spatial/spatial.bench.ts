import { bench, describe } from 'vitest';
import type { Vec3 } from '../math';
import { perspective, random, randomPoint } from '../testing';
import { Aabb } from '../volumes/Aabb';
import { Frustum } from '../volumes/Frustum';
import { Ray } from '../volumes/Ray';
import { LinearIndex } from './LinearIndex';
import { Octree } from './Octree';

// The targets of design/scenegraph.md §12: a level of 10 000 objects of
// which about 10 % are visible, 1 000 of them moving each frame, and the
// static index of 100 000 objects built at once.
const next = random(31);
const box = (center: Vec3, half: number) =>
  new Aabb(
    center.map((c) => c - half) as Vec3,
    center.map((c) => c + half) as Vec3,
  );
// Objects on a 400 × 400 ground.
const place = (): Vec3 => {
  const [x, , z] = randomPoint(next, 200);
  return [x, next() * 4, z];
};

const count = 10_000;
const entries = Array.from(
  { length: count },
  (_, i) => [i, box(place(), 0.5 + next())] as const,
);
const octree = new Octree<number>();
octree.insertAll(entries);
const linear = new LinearIndex<number>();
for (const [item, bounds] of entries) {
  linear.insert(item, bounds);
}
// A camera above the ground, looking down at a part of it.
const frustum = Frustum.fromMatrix(
  perspective(0.8, 1.6, 0.5, 120, [0, 40, 60]),
);
let visible = 0;
octree.queryFrustum(frustum, () => visible++);

const moving = entries.slice(0, 1000).map(([item, bounds]) => ({
  item,
  bounds: bounds.bounds(),
}));
const staticEntries = Array.from(
  { length: 100_000 },
  (_, i) => [i, box(place(), 0.5)] as const,
);

describe(`spatial index, ${count} items (${visible} in the frustum)`, () => {
  bench('octree: frustum query', () => {
    octree.queryFrustum(frustum, () => undefined);
  });

  bench('linear: frustum query', () => {
    linear.queryFrustum(frustum, () => undefined);
  });

  bench('octree: 1000 items moving a little', () => {
    for (const entry of moving) {
      for (let axis = 0; axis < 3; axis++) {
        const step = (next() - 0.5) * 0.2;
        entry.bounds.min[axis] += step;
        entry.bounds.max[axis] += step;
      }
      octree.update(entry.item, entry.bounds);
    }
  });

  bench('octree: nearest ray hit', () => {
    octree.raycast(new Ray([0, 2, 0], [1, 0, 0.3]), () => false);
  });

  bench(
    'octree: 100 000 items indexed at once',
    () => {
      new Octree<number>().insertAll(staticEntries);
    },
    { iterations: 5 },
  );
});
