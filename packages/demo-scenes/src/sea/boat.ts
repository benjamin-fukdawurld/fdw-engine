import type { IVec3 } from '@fdw/engine-backend';
import { Mesh } from '@fdw/engine-core';

/** A rowing boat: its mesh, the points of its hull, where the water pushes. */
export interface Boat {
  readonly mesh: Mesh;
  /** The points of the hull, x, y, z each: its convex collider. */
  readonly hull: Float32Array;
  /** The points of the bottom where the water pushes (see Buoyancy). */
  readonly floats: readonly IVec3[];
  /** The volume of the hull under the gunwale, in m³. */
  readonly volume: number;
}

/**
 * A rowing boat along z, its bow toward +z: a shell of sections from the
 * flat stern to the pointed bow, U-shaped, the gunwale rising toward the
 * bow, closed by a transom; two thwarts across. Its origin is at the
 * waterline, the keel below.
 */
export function createBoat({
  length = 3.6,
  width = 1.4,
  depth = 0.45,
}: { length?: number; width?: number; depth?: number } = {}): Boat {
  const sections = 24;
  const around = 14;
  const positions: number[] = [];
  const indices: number[] = [];
  // The half width, depth below the waterline and gunwale height along t
  // (-1: stern, 1: bow).
  const halfWidth = (t: number) =>
    (width / 2) *
    (t < 0 ? 1 - 0.35 * t * t : Math.sqrt(Math.max(1 - t * t, 0)));
  const keel = (t: number) => depth * (1 - 0.35 * t * t);
  const gunwale = (t: number) => 0.32 + 0.18 * t * t * (t > 0 ? 1.5 : 0.5);
  const point = (t: number, phi: number): [number, number, number] => {
    const top = gunwale(t);
    const s = Math.pow(Math.sin(phi), 0.6);
    return [
      halfWidth(t) * Math.cos(phi),
      top - (top + keel(t)) * s,
      (t * length) / 2,
    ];
  };
  for (let i = 0; i <= sections; i++) {
    const t = -1 + (2 * i) / sections;
    for (let j = 0; j <= around; j++) {
      positions.push(...point(t, (Math.PI * j) / around));
    }
  }
  const row = around + 1;
  for (let i = 0; i < sections; i++) {
    for (let j = 0; j < around; j++) {
      const a = i * row + j;
      const b = a + row;
      // Counter-clockwise seen from outside, below the hull.
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  // The transom: a fan from the middle of the stern.
  const middle = positions.length / 3;
  positions.push(0, (gunwale(-1) - keel(-1)) / 2, -length / 2);
  for (let j = 0; j < around; j++) {
    indices.push(middle, j, j + 1);
  }
  // A plank between the two sides, at a height: a flat box.
  const plank = (z: number, y: number, along: number) => {
    const t = (2 * z) / length;
    const half = halfWidth(t) * 0.97;
    const base = positions.length / 3;
    for (const [dy, dz] of [
      [0, -along],
      [0, along],
      [-0.04, -along],
      [-0.04, along],
    ]) {
      positions.push(-half, y + dy, z + dz, half, y + dy, z + dz);
    }
    // Top (two triangles), then the front and back faces.
    const [l0, r0, l1, r1, l2, r2, l3, r3] = [0, 1, 2, 3, 4, 5, 6, 7].map(
      (k) => base + k,
    );
    indices.push(l0, l1, r0, r0, l1, r1);
    indices.push(l2, l0, r2, r2, l0, r0, l1, l3, r1, r1, l3, r3);
  };
  plank(-0.55, 0.12, 0.13);
  plank(0.45, 0.14, 0.13);

  // Smooth normals: the faces around each vertex, by area.
  const normals = new Float32Array(positions.length);
  for (let k = 0; k < indices.length; k += 3) {
    const [a, b, c] = [indices[k], indices[k + 1], indices[k + 2]];
    const e1 = [0, 1, 2].map(
      (i) => positions[b * 3 + i] - positions[a * 3 + i],
    );
    const e2 = [0, 1, 2].map(
      (i) => positions[c * 3 + i] - positions[a * 3 + i],
    );
    const n = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    for (const v of [a, b, c]) {
      for (let i = 0; i < 3; i++) {
        normals[v * 3 + i] += n[i];
      }
    }
  }
  const count = positions.length / 3;
  const vertices = new Float32Array(count * 6);
  for (let v = 0; v < count; v++) {
    const [x, y, z] = [0, 1, 2].map((i) => normals[v * 3 + i]);
    const length = Math.hypot(x, y, z) || 1;
    vertices.set(
      [
        positions[v * 3],
        positions[v * 3 + 1],
        positions[v * 3 + 2],
        x / length,
        y / length,
        z / length,
      ],
      v * 6,
    );
  }
  const mesh = new Mesh({
    label: 'boat',
    description: {
      vertexBuffers: [
        {
          stride: 24,
          stepMode: 'vertex',
          attributes: [
            { semantic: 'position', format: 'float32x3', offset: 0 },
            { semantic: 'normal', format: 'float32x3', offset: 12 },
          ],
        },
      ],
      vertexCount: count,
      indexBuffer: { format: 'uint16', count: indices.length },
    },
    vertices: [vertices],
    indices: new Uint16Array(indices),
  });

  // The hull alone (not the planks), for its collider.
  const hull = new Float32Array(positions.slice(0, (sections + 1) * row * 3));
  // The bottom: 5 sections × 3 points, at mid depth.
  const floats: IVec3[] = [];
  for (const t of [-0.8, -0.4, 0, 0.4, 0.75]) {
    for (const side of [-0.55, 0, 0.55]) {
      floats.push({
        x: halfWidth(t) * side,
        y: -keel(t) * 0.45,
        z: (t * length) / 2,
      });
    }
  }
  // About the volume under the gunwale: a share of the box around it.
  const volume = length * width * (depth + gunwale(0)) * 0.5;
  return { mesh, hull, floats, volume };
}
