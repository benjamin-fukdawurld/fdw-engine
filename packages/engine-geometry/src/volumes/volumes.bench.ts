import { bench, describe } from 'vitest';
import {
  compose,
  perspective,
  random,
  randomPoint,
  randomRotation,
} from '../testing';
import { Aabb, transformAabb } from './Aabb';
import { Capsule } from './Capsule';
import { Frustum } from './Frustum';
import { gjkIntersects } from './gjk';
import { Obb } from './Obb';
import { Sphere } from './Sphere';

// The tests run per object and per frame by the culling and the queries.
const next = random(11);
const count = 10_000;
const boxes = Array.from({ length: count }, () => {
  const center = randomPoint(next, 50);
  return new Aabb(
    center.map((c) => c - 1) as [number, number, number],
    center.map((c) => c + 1) as [number, number, number],
  );
});
const frustum = Frustum.fromMatrix(perspective(1, 1.6, 0.1, 100));
const matrices = Array.from({ length: count }, () =>
  compose(randomPoint(next, 10), randomRotation(next), [1, 2, 1]),
);
const out = new Aabb();
const pairs = Array.from({ length: 1000 }, () => [
  new Obb(
    randomPoint(next, 2),
    [1, 0.5, 0.5],
    [
      [1, 1, 0],
      [-1, 1, 0],
      [0, 0, 1],
    ],
  ),
  new Capsule(randomPoint(next, 2), randomPoint(next, 2), 0.4),
]);
const spheres = Array.from({ length: 1000 }, () => [
  new Sphere(randomPoint(next, 2), 0.8),
  new Sphere(randomPoint(next, 2), 0.8),
]);

describe('volumes', () => {
  bench(`frustum.classifyAabb, ${count} boxes`, () => {
    for (const box of boxes) {
      frustum.classifyAabb(box);
    }
  });

  bench(`transformAabb, ${count} boxes`, () => {
    for (let i = 0; i < count; i++) {
      transformAabb(boxes[i], matrices[i], out);
    }
  });

  bench('GJK, 1000 oriented boxes against capsules', () => {
    for (const [a, b] of pairs) {
      gjkIntersects(a, b);
    }
  });

  bench('sphere against sphere, 1000 pairs', () => {
    for (const [a, b] of spheres) {
      (a as Sphere).intersectsSphere(b as Sphere);
    }
  });
});
