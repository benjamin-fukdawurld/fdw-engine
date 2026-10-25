import { Bvh, buildBvh, BvhOptions, traverseBvh } from './Bvh';

/** Floats per triangle of a {@link TriangleBvh}: three vec4. */
export const TriangleFloats = 12;

/**
 * A BVH over the triangles of a mesh, with the triangles in the order of
 * its leaves: 12 floats each, v0 (xyz), the index of the triangle in the
 * mesh (the bits of a u32), v1 - v0 (xyz), 0, v2 - v0 (xyz), 0. What the
 * rays test, on the CPU and in the software ray tracing of WebGPU.
 */
export interface TriangleBvh extends Bvh {
  readonly triangles: Float32Array<ArrayBuffer>;
  readonly triangleCount: number;
}

/**
 * Builds the BVH of a triangle mesh: positions (xyz per vertex) and
 * indices (3 per triangle; without them, the vertices taken 3 by 3).
 */
export function buildTriangleBvh(
  positions: ArrayLike<number>,
  indices?: ArrayLike<number>,
  options?: BvhOptions,
): TriangleBvh {
  const count = Math.floor(
    (indices ? indices.length : positions.length / 3) / 3,
  );
  const vertex = (triangle: number, corner: number) =>
    (indices ? indices[triangle * 3 + corner] : triangle * 3 + corner) * 3;
  const boxes = new Float32Array(count * 6);
  for (let t = 0; t < count; t++) {
    for (let axis = 0; axis < 3; axis++) {
      const a = positions[vertex(t, 0) + axis];
      const b = positions[vertex(t, 1) + axis];
      const c = positions[vertex(t, 2) + axis];
      boxes[t * 6 + axis] = Math.min(a, b, c);
      boxes[t * 6 + 3 + axis] = Math.max(a, b, c);
    }
  }
  const bvh = buildBvh(boxes, options);
  const buffer = new ArrayBuffer(count * TriangleFloats * 4);
  const triangles = new Float32Array(buffer);
  const bits = new Uint32Array(buffer);
  for (let i = 0; i < count; i++) {
    const t = bvh.order[i];
    const o = i * TriangleFloats;
    const v0 = vertex(t, 0);
    const v1 = vertex(t, 1);
    const v2 = vertex(t, 2);
    for (let axis = 0; axis < 3; axis++) {
      const p0 = positions[v0 + axis];
      triangles[o + axis] = p0;
      triangles[o + 4 + axis] = positions[v1 + axis] - p0;
      triangles[o + 8 + axis] = positions[v2 + axis] - p0;
    }
    bits[o + 3] = t;
  }
  return { ...bvh, triangles, triangleCount: count };
}

/**
 * Where a ray hits a triangle: its distance along the direction (in units
 * of its length), the index of the triangle in the mesh, the barycentric
 * coordinates of the point (weights of v1 and v2), and whether the
 * triangle is seen from its front (counterclockwise).
 */
export interface TriangleHit {
  t: number;
  triangle: number;
  u: number;
  v: number;
  frontFace: boolean;
}

/**
 * Tests a ray against the triangles of a leaf (Möller-Trumbore): updates
 * `hit` with a closer one, within (tMin, hit.t). Returns whether one was
 * found.
 */
export function intersectTriangles(
  bvh: TriangleBvh,
  first: number,
  count: number,
  origin: ArrayLike<number>,
  direction: ArrayLike<number>,
  tMin: number,
  hit: TriangleHit,
): boolean {
  const triangles = bvh.triangles;
  const bits = new Uint32Array(triangles.buffer);
  const [dx, dy, dz] = [direction[0], direction[1], direction[2]];
  let found = false;
  for (let i = first; i < first + count; i++) {
    const o = i * TriangleFloats;
    const e1x = triangles[o + 4];
    const e1y = triangles[o + 5];
    const e1z = triangles[o + 6];
    const e2x = triangles[o + 8];
    const e2y = triangles[o + 9];
    const e2z = triangles[o + 10];
    // p = d × e2, det = e1 · p.
    const px = dy * e2z - dz * e2y;
    const py = dz * e2x - dx * e2z;
    const pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det === 0) {
      continue;
    }
    const inverse = 1 / det;
    const sx = origin[0] - triangles[o];
    const sy = origin[1] - triangles[o + 1];
    const sz = origin[2] - triangles[o + 2];
    const u = (sx * px + sy * py + sz * pz) * inverse;
    if (u < 0 || u > 1) {
      continue;
    }
    // q = s × e1.
    const qx = sy * e1z - sz * e1y;
    const qy = sz * e1x - sx * e1z;
    const qz = sx * e1y - sy * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inverse;
    if (v < 0 || u + v > 1) {
      continue;
    }
    const t = (e2x * qx + e2y * qy + e2z * qz) * inverse;
    if (t > tMin && t < hit.t) {
      hit.t = t;
      hit.u = u;
      hit.v = v;
      hit.triangle = bits[o + 3];
      // det = -(d · (e1 × e2)): positive when the ray meets the front.
      hit.frontFace = det > 0;
      found = true;
    }
  }
  return found;
}

/**
 * Casts a ray against a triangle BVH: the closest hit within (tMin, tMax),
 * or with `mode` 'any' the first one found (enough for a shadow). The
 * direction need not be normalized: t is in units of its length.
 */
export function intersectTriangleBvh(
  bvh: TriangleBvh,
  origin: ArrayLike<number>,
  direction: ArrayLike<number>,
  {
    tMin = 0,
    tMax = Infinity,
    mode = 'closest',
  }: { tMin?: number; tMax?: number; mode?: 'closest' | 'any' } = {},
): TriangleHit | undefined {
  const hit: TriangleHit = {
    t: tMax,
    triangle: -1,
    u: 0,
    v: 0,
    frontFace: true,
  };
  traverseBvh(
    bvh,
    origin,
    direction,
    tMin,
    () => hit.t,
    (first, count) =>
      intersectTriangles(bvh, first, count, origin, direction, tMin, hit) &&
      mode === 'any',
  );
  return hit.triangle >= 0 ? hit : undefined;
}
