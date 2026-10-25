import type { Matrix4 } from '../math';
import { Bvh, buildBvh, BvhOptions, traverseBvh } from './Bvh';
import {
  intersectTriangles,
  TriangleBvh,
  TriangleHit,
} from './triangles';

/** A mesh placed in the world: what the top level of a scene holds. */
export interface BvhInstance {
  readonly bvh: TriangleBvh;
  /** Object to world, column-major. */
  readonly world: Matrix4;
  /** The rays whose mask shares a bit with it see the instance (0xff). */
  readonly mask?: number;
}

/**
 * The box of a box of 6 floats (min xyz, max xyz, from `offset`)
 * transformed by a matrix, written into `out` (6 floats from `at`).
 */
export function transformBox(
  matrix: Matrix4,
  box: ArrayLike<number>,
  out: Float32Array | Float64Array,
  at = 0,
  offset = 0,
): void {
  // The center moved, the half extent through the absolute matrix.
  for (let row = 0; row < 3; row++) {
    let center = matrix[12 + row];
    let extent = 0;
    for (let column = 0; column < 3; column++) {
      const m = matrix[column * 4 + row];
      const c = (box[offset + column] + box[offset + 3 + column]) / 2;
      const e = (box[offset + 3 + column] - box[offset + column]) / 2;
      center += m * c;
      extent += Math.abs(m) * e;
    }
    out[at + row] = center - extent;
    out[at + 3 + row] = center + extent;
  }
}

/** The BVH of instances: over their world boxes. */
export function buildInstanceBvh(
  instances: readonly BvhInstance[],
  options?: BvhOptions,
): Bvh {
  const boxes = new Float32Array(instances.length * 6);
  instances.forEach((instance, i) =>
    transformBox(instance.world, instance.bvh.bounds, boxes, i * 6),
  );
  return buildBvh(boxes, { maxLeafSize: 1, ...options });
}

/** The inverse of an affine matrix (column-major), into out. */
export function invertAffine(
  matrix: Matrix4,
  out: Float64Array = new Float64Array(16),
): Float64Array {
  const [a, b, c] = [matrix[0], matrix[1], matrix[2]];
  const [d, e, f] = [matrix[4], matrix[5], matrix[6]];
  const [g, h, i] = [matrix[8], matrix[9], matrix[10]];
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const s = det === 0 ? 0 : 1 / det;
  // The inverse of the 3 × 3 part (columns), then -R⁻¹ t.
  out[0] = A * s;
  out[1] = (c * h - b * i) * s;
  out[2] = (b * f - c * e) * s;
  out[3] = 0;
  out[4] = B * s;
  out[5] = (a * i - c * g) * s;
  out[6] = (c * d - a * f) * s;
  out[7] = 0;
  out[8] = C * s;
  out[9] = (b * g - a * h) * s;
  out[10] = (a * e - b * d) * s;
  out[11] = 0;
  const [tx, ty, tz] = [matrix[12], matrix[13], matrix[14]];
  for (let row = 0; row < 3; row++) {
    out[12 + row] = -(
      out[row] * tx +
      out[4 + row] * ty +
      out[8 + row] * tz
    );
  }
  out[15] = 1;
  return out;
}

/** A hit of a ray in a scene of instances: the instance touched too. */
export interface InstanceHit extends TriangleHit {
  instance: number;
}

/**
 * Casts a ray against instances (the top level `top`, built by
 * buildInstanceBvh from them): the closest hit within (tMin, tMax), or with
 * `mode` 'any' the first found. The ray is moved into the space of each
 * instance it meets, without normalizing its direction: t is the same in
 * both spaces. The reference of the GPU traversals.
 */
export function intersectInstances(
  top: Bvh,
  instances: readonly BvhInstance[],
  origin: ArrayLike<number>,
  direction: ArrayLike<number>,
  {
    tMin = 0,
    tMax = Infinity,
    mode = 'closest',
    mask = 0xff,
  }: {
    tMin?: number;
    tMax?: number;
    mode?: 'closest' | 'any';
    mask?: number;
  } = {},
): InstanceHit | undefined {
  const hit: InstanceHit = {
    t: tMax,
    triangle: -1,
    u: 0,
    v: 0,
    frontFace: true,
    instance: -1,
  };
  const inverse = new Float64Array(16);
  const localOrigin = new Float64Array(3);
  const localDirection = new Float64Array(3);
  traverseBvh(
    top,
    origin,
    direction,
    tMin,
    () => hit.t,
    (first, count) => {
      for (let i = first; i < first + count; i++) {
        const index = top.order[i];
        const instance = instances[index];
        if (((instance.mask ?? 0xff) & mask) === 0) {
          continue;
        }
        invertAffine(instance.world, inverse);
        for (let row = 0; row < 3; row++) {
          localOrigin[row] =
            inverse[row] * origin[0] +
            inverse[4 + row] * origin[1] +
            inverse[8 + row] * origin[2] +
            inverse[12 + row];
          localDirection[row] =
            inverse[row] * direction[0] +
            inverse[4 + row] * direction[1] +
            inverse[8 + row] * direction[2];
        }
        let found = false;
        traverseBvh(
          instance.bvh,
          localOrigin,
          localDirection,
          tMin,
          () => hit.t,
          (leafFirst, leafCount) => {
            found =
              intersectTriangles(
                instance.bvh,
                leafFirst,
                leafCount,
                localOrigin,
                localDirection,
                tMin,
                hit,
              ) || found;
            return found && mode === 'any';
          },
        );
        if (found) {
          hit.instance = index;
          if (mode === 'any') {
            return true;
          }
        }
      }
      return false;
    },
  );
  return hit.instance >= 0 ? hit : undefined;
}
