import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../math';
import { between, perspective, random, randomPoint } from '../testing';
import { Aabb } from '../volumes/Aabb';
import { Capsule } from '../volumes/Capsule';
import { Frustum } from '../volumes/Frustum';
import { Ray } from '../volumes/Ray';
import { Sphere } from '../volumes/Sphere';
import { LinearIndex } from './LinearIndex';
import { Octree } from './Octree';
import type { SpatialIndex } from './SpatialIndex';

const randomBox = (next: () => number, extent: number, size: number): Aabb => {
  const center = randomPoint(next, extent);
  const half = [0, 1, 2].map(() => between(next, 0.01, size));
  return new Aabb(
    center.map((c, i) => c - half[i]) as Vec3,
    center.map((c, i) => c + half[i]) as Vec3,
  );
};

const frustumResults = (index: SpatialIndex<number>, frustum: Frustum) => {
  const results: string[] = [];
  index.queryFrustum(frustum, (item, inside) =>
    results.push(`${item}:${inside}`),
  );
  return results.sort();
};

const volumeResults = (
  index: SpatialIndex<number>,
  volume: Capsule | Sphere | Aabb,
) => {
  const results: number[] = [];
  index.queryVolume(volume, (item) => {
    results.push(item);
  });
  return results.sort((a, b) => a - b);
};

const rayResults = (index: SpatialIndex<number>, ray: Ray, max?: number) => {
  const results: [number, number][] = [];
  index.raycast(
    ray,
    (item, distance) => {
      results.push([item, distance]);
    },
    max,
  );
  return results;
};

// The octree must give the results of the linear index: the same items for
// the same queries, after any sequence of insertions, moves and removals.
function compare(
  octree: Octree<number>,
  linear: LinearIndex<number>,
  next: () => number,
) {
  expect(octree.size).toBe(linear.size);
  let found = 0;
  for (let q = 0; q < 10; q++) {
    const eye = randomPoint(next, 60);
    const frustum = Frustum.fromMatrix(
      perspective(between(next, 0.5, 1.5), 1.5, 0.5, 80, eye),
    );
    const visible = frustumResults(linear, frustum);
    expect(frustumResults(octree, frustum)).toEqual(visible);
    found += visible.length;

    const volumes = [
      new Sphere(randomPoint(next, 50), between(next, 1, 15)),
      new Capsule(
        randomPoint(next, 50),
        randomPoint(next, 50),
        between(next, 0.5, 5),
      ),
      randomBox(next, 50, 10),
    ];
    for (const volume of volumes) {
      expect(volumeResults(octree, volume)).toEqual(
        volumeResults(linear, volume),
      );
    }

    const ray = new Ray(randomPoint(next, 60), randomPoint(next, 1));
    const expected = rayResults(linear, ray);
    const actual = rayResults(octree, ray);
    // Same items, nearest first (ties in any order).
    expect(actual.map(([item]) => item).sort()).toEqual(
      expected.map(([item]) => item).sort(),
    );
    for (let i = 1; i < actual.length; i++) {
      expect(actual[i][1]).toBeGreaterThanOrEqual(actual[i - 1][1]);
    }
    const nearLimit = rayResults(octree, ray, 20);
    expect(nearLimit.length).toBe(expected.filter(([, d]) => d <= 20).length);
    found += expected.length;
  }
  // The queries found items: the comparison is not empty.
  expect(found).toBeGreaterThan(100);
}

describe('Octree', () => {
  it('answers as the linear index, through insertions, moves and removals', () => {
    const next = random(21);
    const octree = new Octree<number>();
    const linear = new LinearIndex<number>();
    let id = 0;
    const alive: number[] = [];
    for (let round = 0; round < 6; round++) {
      // Insertions: small items, and a few large ones.
      for (let i = 0; i < 400; i++) {
        const box = randomBox(next, 50, i % 50 === 0 ? 20 : 2);
        octree.insert(id, box);
        linear.insert(id, box);
        alive.push(id++);
      }
      // Moves: small steps (in their cell) and jumps.
      for (const item of alive) {
        if (next() < 0.3) {
          const box =
            next() < 0.5 ? randomBox(next, 50, 2) : randomBox(next, 60, 3);
          octree.update(item, box);
          linear.update(item, box);
        }
      }
      // Removals.
      for (let i = 0; i < 100; i++) {
        const [item] = alive.splice(Math.floor(next() * alive.length), 1);
        expect(octree.remove(item)).toBe(true);
        linear.remove(item);
      }
      compare(octree, linear, next);
    }
  });

  it('grows its root for items outside of it', () => {
    const octree = new Octree<number>();
    octree.insert(1, new Aabb([0, 0, 0], [1, 1, 1]));
    octree.insert(2, new Aabb([1000, -500, 300], [1001, -499, 301]));
    octree.insert(3, new Aabb([-2000, 0, 0], [-1999, 1, 1]));
    const found: number[] = [];
    octree.queryVolume(
      new Aabb([-1e4, -1e4, -1e4], [1e4, 1e4, 1e4]),
      (item) => {
        found.push(item);
      },
    );
    expect(found.sort()).toEqual([1, 2, 3]);
    expect(octree.bounds(new Aabb()).min).toEqual([-2000, -500, 0]);
  });

  it('removes the cells left empty', () => {
    const next = random(22);
    const octree = new Octree<number>();
    for (let i = 0; i < 1000; i++) {
      octree.insert(i, randomBox(next, 100, 1));
    }
    expect(octree.cellCount).toBeGreaterThan(50);
    for (let i = 1; i < 1000; i++) {
      octree.remove(i);
    }
    expect(octree.size).toBe(1);
    // The root, and the cells down to the last item.
    expect(octree.cellCount).toBeLessThan(12);
  });

  it('indexes many items at once', () => {
    const next = random(23);
    const octree = new Octree<number>();
    const linear = new LinearIndex<number>();
    const entries = Array.from(
      { length: 3000 },
      (_, i) => [i, randomBox(next, 80, 1.5)] as const,
    );
    octree.insertAll(entries);
    for (const [item, box] of entries) {
      linear.insert(item, box);
    }
    compare(octree, linear, next);
  });

  it('stops a query when asked to', () => {
    const octree = new Octree<number>();
    for (let i = 0; i < 10; i++) {
      octree.insert(i, new Aabb([i * 3, 0, 0], [i * 3 + 1, 1, 1]));
    }
    const seen: number[] = [];
    octree.raycast(new Ray([-5, 0.5, 0.5], [1, 0, 0]), (item) => {
      seen.push(item);
      return seen.length < 3;
    });
    expect(seen).toEqual([0, 1, 2]);
  });

  it('refuses to insert an item twice, or to move an unknown one', () => {
    const octree = new Octree<string>();
    octree.insert('a', new Aabb());
    expect(() => octree.insert('a', new Aabb())).toThrow(/already indexed/);
    expect(() => octree.update('b', new Aabb())).toThrow(/not indexed/);
    expect(octree.remove('b')).toBe(false);
  });
});
