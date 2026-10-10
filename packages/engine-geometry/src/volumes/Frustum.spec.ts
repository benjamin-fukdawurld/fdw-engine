import { describe, expect, it } from 'vitest';
import { transformPoint, vec3 } from '../math';
import {
  compose,
  perspective,
  random,
  randomPoint,
  randomRotation,
} from '../testing';
import { Aabb } from './Aabb';
import { Frustum } from './Frustum';
import { Ray } from './Ray';

// A camera at (0, 0, 5) looking down -z: 90° vertically, square, from 1 to 11.
const camera = () =>
  Frustum.fromMatrix(perspective(Math.PI / 2, 1, 1, 11, [0, 0, 5]));

describe('Frustum', () => {
  it('contains what the camera sees', () => {
    const frustum = camera();
    expect(frustum.containsPoint([0, 0, 0])).toBe(true);
    // Near and far planes: 1 and 11 in front of the camera.
    expect(frustum.containsPoint([0, 0, 4.1])).toBe(false);
    expect(frustum.containsPoint([0, 0, 3.9])).toBe(true);
    expect(frustum.containsPoint([0, 0, -5.9])).toBe(true);
    expect(frustum.containsPoint([0, 0, -6.1])).toBe(false);
    // 45° on each side: at 5 in front, from -5 to 5.
    expect(frustum.containsPoint([4.9, 0, 0])).toBe(true);
    expect(frustum.containsPoint([5.1, 0, 0])).toBe(false);
    expect(frustum.containsPoint([0, -5.1, 0])).toBe(false);
    // Behind the camera.
    expect(frustum.containsPoint([0, 0, 6])).toBe(false);
  });

  it('agrees with the clip space of the matrix', () => {
    const matrix = perspective(1.1, 1.6, 0.5, 40, [1, 2, 3]);
    const frustum = Frustum.fromMatrix(matrix);
    const next = random(3);
    for (let i = 0; i < 5000; i++) {
      const point = randomPoint(next, 40);
      const [x, y, z] = point;
      const clip = [0, 1, 2, 3].map(
        (row) =>
          matrix[row] * x +
          matrix[4 + row] * y +
          matrix[8 + row] * z +
          matrix[12 + row]
      );
      const w = clip[3];
      const inside =
        w > 0 &&
        Math.abs(clip[0]) <= w &&
        Math.abs(clip[1]) <= w &&
        clip[2] >= 0 &&
        clip[2] <= w;
      expect(frustum.containsPoint(point)).toBe(inside);
    }
  });

  it('gives its corners', () => {
    const corners = camera().corners();
    expect(corners).toHaveLength(8);
    // Near corners: ±1 at z = 4; far corners: ±11 at z = -6.
    const near = corners
      .slice(0, 4)
      .map((c) => c.map((v) => Math.round(v * 1e6) / 1e6));
    expect(near).toContainEqual([-1, -1, 4]);
    expect(near).toContainEqual([1, 1, 4]);
    const far = corners
      .slice(4)
      .map((c) => c.map((v) => Math.round(v * 1e6) / 1e6));
    expect(far).toContainEqual([11, -11, -6]);
  });

  it('classifies boxes', () => {
    const frustum = camera();
    expect(frustum.classifyAabb(new Aabb([-1, -1, -1], [1, 1, 1]))).toBe(
      'inside'
    );
    expect(frustum.classifyAabb(new Aabb([4, -1, -1], [6, 1, 1]))).toBe(
      'intersects'
    );
    expect(frustum.classifyAabb(new Aabb([20, -1, -1], [22, 1, 1]))).toBe(
      'outside'
    );
    expect(frustum.classifyAabb(new Aabb([-1, -1, 6], [1, 1, 8]))).toBe(
      'outside'
    );
  });

  it('never classifies as outside a box with a point inside', () => {
    const frustum = camera();
    const next = random(4);
    for (let i = 0; i < 2000; i++) {
      const center = randomPoint(next, 12);
      const half = randomPoint(next, 2).map(Math.abs);
      const box = new Aabb(
        center.map((c, axis) => c - half[axis]) as [number, number, number],
        center.map((c, axis) => c + half[axis]) as [number, number, number]
      );
      const classification = frustum.classifyAabb(box);
      if (frustum.containsPoint(center)) {
        expect(classification).not.toBe('outside');
      }
      if (classification === 'inside') {
        for (const corner of [box.min, box.max]) {
          expect(frustum.containsPoint(corner)).toBe(true);
        }
      }
    }
  });

  it('tests spheres', () => {
    const frustum = camera();
    expect(frustum.intersectsSphere([0, 0, 0], 1)).toBe(true);
    expect(frustum.intersectsSphere([6, 0, 0], 1.5)).toBe(true);
    expect(frustum.intersectsSphere([8, 0, 0], 1)).toBe(false);
  });

  it('raycasts to its entry point', () => {
    const frustum = camera();
    // From behind the camera, along -z: enters at the near plane.
    expect(frustum.raycast(new Ray([0, 0, 10], [0, 0, -1]))).toBeCloseTo(6, 9);
    // From inside.
    expect(frustum.raycast(new Ray([0, 0, 0], [1, 0, 0]))).toBe(0);
    // Away from it.
    expect(frustum.raycast(new Ray([0, 0, 10], [0, 0, 1]))).toBeUndefined();
  });

  it('transforms with a matrix', () => {
    const frustum = camera();
    const next = random(5);
    const matrix = compose(
      randomPoint(next, 3),
      randomRotation(next),
      [1.5, 1.5, 1.5]
    );
    const moved = frustum.transform(matrix);
    for (let i = 0; i < 2000; i++) {
      const point = randomPoint(next, 10);
      expect(moved.containsPoint(transformPoint(vec3(), matrix, point))).toBe(
        frustum.containsPoint(point)
      );
    }
  });
});
