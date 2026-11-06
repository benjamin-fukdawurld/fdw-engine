import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../math';
import { Aabb } from './Aabb';
import { Capsule } from './Capsule';
import { Frustum } from './Frustum';
import { Obb } from './Obb';
import { Sphere } from './Sphere';
import { signedDistance } from './signedDistance';

describe('signedDistance', () => {
  it('measures outside and inside a box, the normal leaving it', () => {
    const box = new Aabb([-1, -1, -1], [1, 1, 1]);
    const normal: Vec3 = [0, 0, 0];
    expect(signedDistance(box, [3, 0, 0], normal)).toBeCloseTo(2);
    expect(normal).toEqual([1, 0, 0]);
    expect(signedDistance(box, [2, 2, 0], normal)).toBeCloseTo(Math.SQRT2);
    expect(normal[0]).toBeCloseTo(Math.SQRT1_2);
    expect(signedDistance(box, [0, 0.75, 0], normal)).toBeCloseTo(-0.25);
    expect(normal).toEqual([0, 1, 0]);
  });

  it('turns the oriented boxes', () => {
    const s = Math.SQRT1_2;
    // A box turned 45° around y.
    const box = new Obb(
      [0, 0, 0],
      [1, 1, 1],
      [
        [s, 0, -s],
        [0, 1, 0],
        [s, 0, s],
      ],
    );
    const normal: Vec3 = [0, 0, 0];
    expect(signedDistance(box, [2, 0, 0], normal)).toBeCloseTo(2 - Math.SQRT2);
    expect(normal[0]).toBeCloseTo(1);
    expect(normal[2]).toBeCloseTo(0);
  });

  it('measures the spheres and the capsules', () => {
    const normal: Vec3 = [0, 0, 0];
    expect(signedDistance(new Sphere([0, 1, 0], 1), [0, 4, 0], normal)).toBe(2);
    expect(normal).toEqual([0, 1, 0]);
    const capsule = new Capsule([0, 0, 0], [0, 2, 0], 0.5);
    expect(signedDistance(capsule, [1, 1, 0], normal)).toBeCloseTo(0.5);
    expect(normal).toEqual([1, 0, 0]);
    expect(signedDistance(capsule, [0, -1, 0])).toBeCloseTo(0.5);
  });

  it('knows nothing of the other volumes', () => {
    expect(
      signedDistance(
        Frustum.fromMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
        [0, 0, 0],
      ),
    ).toBeUndefined();
  });
});
