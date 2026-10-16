import { Aabb } from './Aabb';
import { Capsule } from './Capsule';
import { gjkIntersects } from './gjk';
import { Sphere } from './Sphere';
import { isConvex, Volume } from './Volume';

/** An exact intersection test between two kinds of volumes. */
export type IntersectionTest<
  A extends Volume = Volume,
  B extends Volume = Volume,
> = (a: A, b: B) => boolean;

const tests = new Map<string, IntersectionTest>();
const key = (a: string, b: string) => `${a}\u0000${b}`;

/**
 * Registers a fast, exact test between two kinds of volumes, used by
 * intersects() before GJK. Registered for both orders.
 */
export function registerIntersection<A extends Volume, B extends Volume>(
  kindA: string,
  kindB: string,
  test: IntersectionTest<A, B>,
): void {
  tests.set(key(kindA, kindB), test as IntersectionTest);
  tests.set(key(kindB, kindA), (b, a) => test(a as A, b as B));
}

/**
 * Whether two volumes intersect: the test registered for their kinds, or GJK
 * when both are convex. Throws for a non-convex volume without a test.
 */
export function intersects(a: Volume, b: Volume): boolean {
  const test = tests.get(key(a.kind, b.kind));
  if (test) {
    return test(a, b);
  }
  if (isConvex(a) && isConvex(b)) {
    return gjkIntersects(a, b);
  }
  throw new Error(
    `No intersection test between "${a.kind}" and "${b.kind}": give the volumes a support function, or register a test with registerIntersection()`,
  );
}

registerIntersection<Aabb, Aabb>('aabb', 'aabb', (a, b) => a.intersectsAabb(b));
registerIntersection<Sphere, Sphere>('sphere', 'sphere', (a, b) =>
  a.intersectsSphere(b),
);
registerIntersection<Sphere, Aabb>('sphere', 'aabb', (a, b) =>
  a.intersectsAabb(b),
);
registerIntersection<Capsule, Capsule>('capsule', 'capsule', (a, b) =>
  a.intersectsCapsule(b),
);
registerIntersection<Capsule, Sphere>('capsule', 'sphere', (a, b) =>
  a.intersectsSphere(b.center, b.radius),
);
