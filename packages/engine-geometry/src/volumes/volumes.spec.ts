import { describe, expect, it } from 'vitest';
import { dot, transformPoint, Vec3, vec3 } from '../math';
import {
  between,
  compose,
  random,
  randomPoint,
  randomRotation,
} from '../testing';
import { Aabb, transformAabb } from './Aabb';
import { Capsule } from './Capsule';
import { Obb } from './Obb';
import { Ray } from './Ray';
import { Sphere } from './Sphere';
import type { ConvexVolume } from './Volume';

const next = random(1);

const randomVolumes = (): ConvexVolume[] => [
  new Aabb([-1, -0.5, -2], [1.5, 1, 0.5]),
  new Sphere([0.3, -0.2, 0.5], 1.2),
  new Obb(
    [0.2, 0.1, -0.3],
    [1, 0.4, 0.7],
    [
      [1, 1, 0],
      [-1, 1, 0],
      [0, 0, 1],
    ],
  ),
  new Capsule([-1, 0, 0], [1, 0.5, 0.2], 0.6),
];

// The distance along a ray to a volume, by marching: the reference of the
// analytic raycasts.
function march(volume: ConvexVolume, ray: Ray): number | undefined {
  const step = 0.0005;
  for (let t = 0; t < 20; t += step) {
    if (volume.containsPoint(ray.at(t))) {
      return t;
    }
  }
  return undefined;
}

describe('volumes', () => {
  it('bound their points', () => {
    for (const volume of randomVolumes()) {
      const box = volume.bounds();
      for (let i = 0; i < 2000; i++) {
        const point = randomPoint(next, 3);
        if (volume.containsPoint(point)) {
          expect(box.containsPoint(point)).toBe(true);
        }
      }
    }
  });

  it('give support points of the volume, farthest along the direction', () => {
    for (const volume of randomVolumes()) {
      for (let i = 0; i < 50; i++) {
        const direction = randomPoint(next, 1);
        const support = volume.support(direction, vec3());
        // On the volume (up to rounding)…
        const inward: Vec3 = [
          support[0] - direction[0] * 1e-6,
          support[1] - direction[1] * 1e-6,
          support[2] - direction[2] * 1e-6,
        ];
        expect(volume.containsPoint(inward)).toBe(true);
        // …and no point of the volume is farther.
        const reach = dot(support, direction);
        for (let j = 0; j < 500; j++) {
          const point = randomPoint(next, 3);
          if (volume.containsPoint(point)) {
            expect(dot(point, direction)).toBeLessThanOrEqual(reach + 1e-9);
          }
        }
      }
    }
  });

  it('raycast as marching along the ray does', () => {
    for (const volume of randomVolumes()) {
      for (let i = 0; i < 40; i++) {
        const ray = new Ray(randomPoint(next, 4), randomPoint(next, 1));
        const expected = march(volume, ray);
        const distance = volume.raycast(ray);
        if (expected === undefined) {
          // A grazing hit can be missed by the march.
          if (distance !== undefined) {
            expect(volume.containsPoint(ray.at(distance + 1e-3))).toBe(true);
          }
        } else {
          expect(distance).toBeDefined();
          expect(distance as number).toBeCloseTo(expected, 2);
        }
      }
    }
  });

  it('start at 0 inside', () => {
    for (const volume of randomVolumes()) {
      const center = volume.bounds().center();
      expect(volume.raycast(new Ray(center, [0, 1, 0]))).toBe(0);
    }
  });

  it('contain the transformed points of the original volume', () => {
    for (const volume of randomVolumes()) {
      for (let i = 0; i < 10; i++) {
        const uniform = between(next, 0.5, 2);
        const matrix = compose(randomPoint(next, 5), randomRotation(next), [
          uniform,
          i % 2 === 0 ? uniform : between(next, 0.5, 2),
          uniform,
        ]);
        const transformed = volume.transform(matrix);
        expect(transformed.kind).toBe(volume.kind);
        for (let j = 0; j < 300; j++) {
          const point = randomPoint(next, 3);
          if (volume.containsPoint(point)) {
            expect(
              transformed.containsPoint(transformPoint(vec3(), matrix, point)),
            ).toBe(true);
          }
        }
      }
    }
  });

  it('keep an oriented box exact under rotations and uniform scales', () => {
    const box = new Obb([1, 2, 3], [1, 2, 0.5]);
    const matrix = compose([0, 0, 0], randomRotation(next), [2, 2, 2]);
    const turned = box.transform(matrix);
    const sorted = [...turned.halfExtents].sort((a, b) => a - b);
    expect(sorted).toEqual([1, 2, 4].map((value) => expect.closeTo(value, 9)));
  });
});

describe('transformAabb', () => {
  it('bounds the eight transformed corners exactly', () => {
    const box = new Aabb([-1, -2, -0.5], [2, 1, 3]);
    for (let i = 0; i < 20; i++) {
      const matrix = compose(randomPoint(next, 5), randomRotation(next), [
        between(next, 0.5, 2),
        between(next, 0.5, 2),
        between(next, 0.5, 2),
      ]);
      const corners: Vec3[] = [];
      for (const x of [box.min[0], box.max[0]]) {
        for (const y of [box.min[1], box.max[1]]) {
          for (const z of [box.min[2], box.max[2]]) {
            corners.push(transformPoint(vec3(), matrix, [x, y, z]));
          }
        }
      }
      const expected = Aabb.fromPoints(corners);
      const actual = transformAabb(box, matrix, new Aabb());
      for (let axis = 0; axis < 3; axis++) {
        expect(actual.min[axis]).toBeCloseTo(expected.min[axis], 9);
        expect(actual.max[axis]).toBeCloseTo(expected.max[axis], 9);
      }
    }
  });

  it('keeps an empty box empty', () => {
    expect(
      transformAabb(
        Aabb.empty(),
        compose([1, 2, 3], [0, 0, 0, 1], [1, 1, 1]),
        new Aabb(),
      ).isEmpty(),
    ).toBe(true);
  });
});
