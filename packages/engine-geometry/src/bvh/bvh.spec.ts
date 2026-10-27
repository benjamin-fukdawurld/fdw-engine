import { describe, expect, it } from 'vitest';
import { between, compose, random, randomPoint } from '../testing';
import { buildBvh, Bvh, BvhNodeFloats } from './Bvh';
import {
  buildInstanceBvh,
  BvhInstance,
  intersectInstances,
  invertAffine,
} from './instances';
import {
  buildTriangleBvh,
  intersectTriangleBvh,
  TriangleBvh,
  TriangleHit,
} from './triangles';

// A soup of small random triangles in a cube of `extent`.
function soup(seed: number, count: number, extent = 10, size = 0.6) {
  const next = random(seed);
  const positions: number[] = [];
  for (let t = 0; t < count; t++) {
    const center = randomPoint(next, extent);
    for (let corner = 0; corner < 3; corner++) {
      for (let axis = 0; axis < 3; axis++) {
        positions.push(center[axis] + between(next, -size, size));
      }
    }
  }
  return new Float32Array(positions);
}

// The leaves of a BVH: [first, count] in the order of the primitives.
function leaves(bvh: Bvh): [number, number][] {
  if (bvh.root.count > 0) {
    return [[bvh.root.ref, bvh.root.count]];
  }
  const found: [number, number][] = [];
  const stack = [bvh.root.ref];
  while (stack.length > 0) {
    const base = (stack.pop() as number) * BvhNodeFloats;
    for (const offset of [0, 8]) {
      const ref = bvh.nodeRefs[base + offset + 3];
      const count = bvh.nodeRefs[base + offset + 7];
      if (count > 0) {
        found.push([ref, count]);
      } else {
        stack.push(ref);
      }
    }
  }
  return found;
}

// The closest hit by testing every triangle.
function bruteForce(
  positions: Float32Array,
  origin: number[],
  direction: number[],
  mode: 'closest' | 'any' = 'closest',
): TriangleHit | undefined {
  let best: TriangleHit | undefined;
  for (let t = 0; t < positions.length / 9; t++) {
    const one = buildTriangleBvh(positions.subarray(t * 9, t * 9 + 9));
    const hit = intersectTriangleBvh(one, origin, direction, {
      tMax: best?.t ?? Infinity,
      mode,
    });
    if (hit) {
      best = { ...hit, triangle: t };
    }
  }
  return best;
}

// From a point around the scene towards a point in it.
const randomRay = (next: () => number) => {
  const origin = randomPoint(next, 14);
  const target = randomPoint(next, 8);
  return {
    origin: origin as number[],
    direction: target.map((t, i) => t - origin[i]),
  };
};

describe('buildBvh', () => {
  it('puts every primitive in a single leaf', () => {
    const bvh = buildTriangleBvh(soup(1, 1000));
    const seen = new Uint32Array(1000);
    for (const [first, count] of leaves(bvh)) {
      expect(count).toBeLessThanOrEqual(4);
      for (let i = first; i < first + count; i++) {
        seen[bvh.order[i]]++;
      }
    }
    expect([...seen].every((n) => n === 1)).toBe(true);
    expect(bvh.nodeCount).toBeLessThan(1000);
  });

  it('gives each node the boxes of its children', () => {
    const positions = soup(2, 500);
    const bvh = buildTriangleBvh(positions);
    // The box of each child holds its triangles, or the boxes of its
    // node.
    const boxOf = (ref: number, count: number): number[] => {
      if (count > 0) {
        const box = [
          Infinity,
          Infinity,
          Infinity,
          -Infinity,
          -Infinity,
          -Infinity,
        ];
        for (let i = ref; i < ref + count; i++) {
          const t = bvh.order[i];
          for (let corner = 0; corner < 3; corner++) {
            for (let axis = 0; axis < 3; axis++) {
              const p = positions[t * 9 + corner * 3 + axis];
              box[axis] = Math.min(box[axis], p);
              box[3 + axis] = Math.max(box[3 + axis], p);
            }
          }
        }
        return box;
      }
      const base = ref * BvhNodeFloats;
      const box: number[] = [];
      for (const offset of [0, 8]) {
        const child = boxOf(
          bvh.nodeRefs[base + offset + 3],
          bvh.nodeRefs[base + offset + 7],
        );
        const stored = [0, 1, 2, 4, 5, 6].map(
          (k) => bvh.nodes[base + offset + k],
        );
        for (let axis = 0; axis < 3; axis++) {
          expect(stored[axis]).toBeLessThanOrEqual(child[axis]);
          expect(stored[3 + axis]).toBeGreaterThanOrEqual(child[3 + axis]);
        }
        box.push(...stored);
      }
      return [0, 1, 2]
        .map((axis) => Math.min(box[axis], box[6 + axis]))
        .concat([3, 4, 5].map((axis) => Math.max(box[axis], box[6 + axis])));
    };
    boxOf(bvh.root.ref, bvh.root.count);
  });

  it('makes a single leaf of a few primitives', () => {
    const bvh = buildTriangleBvh(soup(3, 1));
    expect(bvh.root).toEqual({ ref: 0, count: 1 });
    expect(bvh.nodeCount).toBe(0);
    expect(buildBvh(new Float32Array(0)).root.count).toBe(0);
  });

  it('cuts empty space better than halves', () => {
    // Two clusters far apart, unbalanced: the SAH separates them at once.
    const positions = new Float32Array([
      ...soup(4, 300, 1, 0.1),
      ...soup(5, 30, 1, 0.1).map((p, i) => (i % 3 === 0 ? p + 50 : p)),
    ]);
    const bvh = buildTriangleBvh(positions);
    const base = bvh.root.ref * BvhNodeFloats;
    // One child holds the small cluster only.
    const lefts = [bvh.nodes[base], bvh.nodes[base + 8]].sort((a, b) => a - b);
    expect(lefts[1]).toBeGreaterThan(40);
  });
});

describe('intersectTriangleBvh', () => {
  it('finds the closest hit, as testing every triangle', () => {
    const positions = soup(6, 400);
    const bvh = buildTriangleBvh(positions);
    const next = random(7);
    let hits = 0;
    for (let i = 0; i < 300; i++) {
      const { origin, direction } = randomRay(next);
      const expected = bruteForce(positions, origin, direction);
      const hit = intersectTriangleBvh(bvh, origin, direction);
      expect(hit?.triangle).toBe(expected?.triangle);
      if (hit && expected) {
        hits++;
        expect(hit.t).toBeCloseTo(expected.t, 4);
        expect(hit.u).toBeCloseTo(expected.u, 4);
        expect(hit.v).toBeCloseTo(expected.v, 4);
        expect(hit.frontFace).toBe(expected.frontFace);
      }
    }
    expect(hits).toBeGreaterThan(30);
  });

  it('gives the barycentric coordinates and the face', () => {
    // A counterclockwise triangle seen from +z.
    const bvh = buildTriangleBvh(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
    const front = intersectTriangleBvh(bvh, [0.25, 0.5, 2], [0, 0, -1]);
    expect(front).toMatchObject({ t: 2, u: 0.25, v: 0.5, frontFace: true });
    const back = intersectTriangleBvh(bvh, [0.25, 0.5, -1], [0, 0, 2]);
    expect(back).toMatchObject({ t: 0.5, frontFace: false });
    expect(
      intersectTriangleBvh(bvh, [0.25, 0.5, 2], [0, 0, -1], { tMax: 1.5 }),
    ).toBeUndefined();
  });

  it('stops at any hit for shadows', () => {
    const positions = soup(8, 200);
    const bvh = buildTriangleBvh(positions);
    const next = random(9);
    for (let i = 0; i < 100; i++) {
      const { origin, direction } = randomRay(next);
      const closest = intersectTriangleBvh(bvh, origin, direction);
      const any = intersectTriangleBvh(bvh, origin, direction, { mode: 'any' });
      expect(any === undefined).toBe(closest === undefined);
      if (any && closest) {
        expect(any.t).toBeGreaterThanOrEqual(closest.t - 1e-6);
      }
    }
  });
});

describe('intersectInstances', () => {
  it('finds the hits of moved meshes, as in the world', () => {
    const next = random(10);
    const meshes = [soup(11, 60, 2), soup(12, 80, 3)];
    const bvhs: TriangleBvh[] = meshes.map((m) => buildTriangleBvh(m));
    const worlds = Array.from({ length: 12 }, () => {
      const axis = randomPoint(next, 1);
      const angle = between(next, 0, Math.PI);
      const n = Math.hypot(...axis);
      const s = Math.sin(angle / 2) / n;
      return compose(
        randomPoint(next, 15),
        [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)],
        [between(next, 0.5, 2), between(next, 0.5, 2), between(next, 0.5, 2)],
      );
    });
    const instances: BvhInstance[] = worlds.map((world, i) => ({
      bvh: bvhs[i % 2],
      world,
    }));
    // The same triangles moved into the world, in one mesh.
    const world: number[] = [];
    const owners: number[] = [];
    instances.forEach((instance, i) => {
      const mesh = meshes[i % 2];
      for (let p = 0; p < mesh.length; p += 3) {
        for (let row = 0; row < 3; row++) {
          world.push(
            instance.world[row] * mesh[p] +
              instance.world[4 + row] * mesh[p + 1] +
              instance.world[8 + row] * mesh[p + 2] +
              instance.world[12 + row],
          );
        }
      }
      owners.push(...Array.from({ length: mesh.length / 9 }, () => i));
    });
    const flat = new Float32Array(world);
    const top = buildInstanceBvh(instances);
    let hits = 0;
    for (let i = 0; i < 300; i++) {
      const { origin, direction } = randomRay(next);
      const expected = bruteForce(flat, origin, direction);
      const hit = intersectInstances(top, instances, origin, direction);
      expect(hit?.instance).toBe(
        expected ? owners[expected.triangle] : undefined,
      );
      if (hit && expected) {
        hits++;
        expect(hit.t).toBeCloseTo(expected.t, 3);
      }
    }
    expect(hits).toBeGreaterThan(30);
  });

  it('skips the instances out of the mask of the ray', () => {
    const bvh = buildTriangleBvh(
      new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]),
    );
    const instances: BvhInstance[] = [
      { bvh, world: compose([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]), mask: 1 },
      { bvh, world: compose([0, 0, -2], [0, 0, 0, 1], [1, 1, 1]), mask: 2 },
    ];
    const top = buildInstanceBvh(instances);
    const ray = [
      [0, 0, 5],
      [0, 0, -1],
    ] as const;
    expect(intersectInstances(top, instances, ...ray)?.instance).toBe(0);
    expect(
      intersectInstances(top, instances, ...ray, { mask: 2 })?.instance,
    ).toBe(1);
    expect(
      intersectInstances(top, instances, ...ray, { mask: 4 }),
    ).toBeUndefined();
  });

  it('inverts affine matrices', () => {
    const m = compose([1, 2, 3], [0, Math.SQRT1_2, 0, Math.SQRT1_2], [2, 3, 4]);
    const inverse = invertAffine(m);
    const p = [0.5, -1, 2];
    const moved = [0, 1, 2].map(
      (row) =>
        m[row] * p[0] + m[4 + row] * p[1] + m[8 + row] * p[2] + m[12 + row],
    );
    const back = [0, 1, 2].map(
      (row) =>
        inverse[row] * moved[0] +
        inverse[4 + row] * moved[1] +
        inverse[8 + row] * moved[2] +
        inverse[12 + row],
    );
    back.forEach((value, i) => expect(value).toBeCloseTo(p[i], 6));
  });
});
