import { describe, expect, it } from 'vitest';
import { ReadonlyVec3, set, Vec3 } from '../math';
import { between, random, randomPoint } from '../testing';
import { Aabb } from './Aabb';
import { Capsule } from './Capsule';
import { gjkIntersects } from './gjk';
import { intersects, registerIntersection } from './intersections';
import { Obb } from './Obb';
import { Sphere } from './Sphere';
import type { ConvexVolume, Volume } from './Volume';

// A volume of the application: a cylinder along y. Only its support function
// is needed for intersections.
class Cylinder implements ConvexVolume {
  readonly kind = 'cylinder';
  constructor(
    readonly center: ReadonlyVec3,
    readonly radius: number,
    readonly halfHeight: number
  ) {}

  bounds(out = new Aabb()): Aabb {
    const [x, y, z] = this.center;
    return out.setFrom(
      [x - this.radius, y - this.halfHeight, z - this.radius],
      [x + this.radius, y + this.halfHeight, z + this.radius]
    );
  }
  transform(): Volume {
    throw new Error('not needed');
  }
  containsPoint([x, y, z]: ReadonlyVec3): boolean {
    const [cx, cy, cz] = this.center;
    return (
      Math.abs(y - cy) <= this.halfHeight &&
      (x - cx) ** 2 + (z - cz) ** 2 <= this.radius ** 2
    );
  }
  raycast(): number | undefined {
    return undefined;
  }
  support([dx, dy, dz]: ReadonlyVec3, out: Vec3): Vec3 {
    const horizontal = Math.hypot(dx, dz);
    const [cx, cy, cz] = this.center;
    return set(
      out,
      cx + (horizontal > 0 ? (dx / horizontal) * this.radius : 0),
      cy + (dy >= 0 ? this.halfHeight : -this.halfHeight),
      cz + (horizontal > 0 ? (dz / horizontal) * this.radius : 0)
    );
  }
}

// The exact distance from a point to the cylinder above.
function distanceToCylinder(point: ReadonlyVec3, cylinder: Cylinder): number {
  const [cx, cy, cz] = cylinder.center;
  const radial = Math.max(
    0,
    Math.hypot(point[0] - cx, point[2] - cz) - cylinder.radius
  );
  const vertical = Math.max(0, Math.abs(point[1] - cy) - cylinder.halfHeight);
  return Math.hypot(radial, vertical);
}

const next = random(7);

const randomBox = (): Aabb => {
  const center = randomPoint(next, 3);
  const half = randomPoint(next, 1.5).map((v) => Math.abs(v) + 0.1);
  return new Aabb(
    center.map((c, i) => c - half[i]) as Vec3,
    center.map((c, i) => c + half[i]) as Vec3
  );
};
const randomSphere = (): Sphere =>
  new Sphere(randomPoint(next, 3), between(next, 0.2, 1.5));
const randomCapsule = (): Capsule =>
  new Capsule(
    randomPoint(next, 3),
    randomPoint(next, 3),
    between(next, 0.1, 1)
  );

// Grows or shrinks a volume: two volumes that still intersect when shrunk,
// or still miss when grown, are far from touching.
const resized = (volume: Volume, margin: number): ConvexVolume => {
  if (volume instanceof Sphere) {
    return new Sphere(volume.center, Math.max(0, volume.radius + margin));
  }
  if (volume instanceof Capsule) {
    return new Capsule(
      volume.start,
      volume.end,
      Math.max(0, volume.radius + margin)
    );
  }
  const box = volume as Aabb;
  return new Aabb(
    box.min.map((v) => v - margin) as Vec3,
    box.max.map((v) => v + margin) as Vec3
  );
};

describe('intersects', () => {
  const generators = [randomBox, randomSphere, randomCapsule];

  it('gives the answers of the fast tests with GJK, away from contact', () => {
    let compared = 0;
    for (const makeA of generators) {
      for (const makeB of generators) {
        for (let i = 0; i < 300; i++) {
          const a = makeA();
          const b = makeB();
          const expected = intersects(a, b);
          // Skip the pairs close to touching.
          if (
            intersects(resized(a, -0.01), resized(b, -0.01)) !== expected ||
            intersects(resized(a, 0.01), resized(b, 0.01)) !== expected
          ) {
            continue;
          }
          expect(gjkIntersects(a, b)).toBe(expected);
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(2000);
  });

  it('tests the volumes of the application against the built-in ones', () => {
    let compared = 0;
    for (let i = 0; i < 2000; i++) {
      const cylinder = new Cylinder(
        randomPoint(next, 2),
        between(next, 0.2, 1),
        between(next, 0.2, 1.5)
      );
      const sphere = randomSphere();
      const distance = distanceToCylinder(sphere.center, cylinder);
      if (Math.abs(distance - sphere.radius) < 1e-3) {
        continue;
      }
      expect(intersects(cylinder, sphere)).toBe(distance < sphere.radius);
      compared++;
    }
    expect(compared).toBeGreaterThan(1900);
  });

  it('tests oriented boxes and frustums through GJK', () => {
    const turned = new Obb(
      [0, 0, 0],
      [2, 0.2, 0.2],
      [
        [1, 1, 0],
        [-1, 1, 0],
        [0, 0, 1],
      ]
    );
    // Along the diagonal: touches a box at (1.2, 1.2, 0), not one at (1.2, -1.2, 0).
    expect(intersects(turned, new Aabb([1, 1, -0.2], [1.4, 1.4, 0.2]))).toBe(
      true
    );
    expect(intersects(turned, new Aabb([1, -1.4, -0.2], [1.4, -1, 0.2]))).toBe(
      false
    );
  });

  it('uses the tests registered for a pair of kinds', () => {
    let calls = 0;
    class Point implements Volume {
      readonly kind = 'test-point';
      constructor(readonly at: ReadonlyVec3) {}
      bounds(out = new Aabb()) {
        return out.setFrom(this.at, this.at);
      }
      transform(): Volume {
        return this;
      }
      containsPoint(point: ReadonlyVec3) {
        return point.every((v, i) => v === this.at[i]);
      }
      raycast() {
        return undefined;
      }
    }
    // Not convex (no support function): needs a registered test.
    expect(() =>
      intersects(new Point([0, 0, 0]), new Sphere([0, 0, 0], 1))
    ).toThrow(/No intersection test between "test-point" and "sphere"/);
    registerIntersection<Point, Sphere>(
      'test-point',
      'sphere',
      (point, sphere) => {
        calls++;
        return sphere.containsPoint(point.at);
      }
    );
    expect(intersects(new Point([0, 0, 0]), new Sphere([0, 0, 0], 1))).toBe(
      true
    );
    // Both orders.
    expect(intersects(new Sphere([0, 0, 0], 1), new Point([3, 0, 0]))).toBe(
      false
    );
    expect(calls).toBe(2);
  });
});
