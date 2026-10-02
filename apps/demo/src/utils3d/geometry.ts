import type { MeshAttributeDescription } from '@fdw/engine-backend';
import { Mesh } from '@fdw/engine-core';
import type { MeshData } from './obj-importer';

// A unit cube centered on the origin, with positions, normals and uvs, and
// counter-clockwise faces seen from outside.
export function createCube(): Mesh {
  // Each face: its normal and two axes u, v with u × v = normal.
  const faces: [number[], number[], number[]][] = [
    [
      [0, 0, 1],
      [1, 0, 0],
      [0, 1, 0],
    ],
    [
      [0, 0, -1],
      [-1, 0, 0],
      [0, 1, 0],
    ],
    [
      [1, 0, 0],
      [0, 0, -1],
      [0, 1, 0],
    ],
    [
      [-1, 0, 0],
      [0, 0, 1],
      [0, 1, 0],
    ],
    [
      [0, 1, 0],
      [1, 0, 0],
      [0, 0, -1],
    ],
    [
      [0, -1, 0],
      [1, 0, 0],
      [0, 0, 1],
    ],
  ];
  const corners = [
    [-1, -1, 0, 1],
    [1, -1, 1, 1],
    [1, 1, 1, 0],
    [-1, 1, 0, 0],
  ];

  const vertices: number[] = [];
  const indices: number[] = [];
  faces.forEach(([normal, u, v], face) => {
    for (const [su, sv, uvx, uvy] of corners) {
      for (let axis = 0; axis < 3; axis++) {
        vertices.push(0.5 * (normal[axis] + su * u[axis] + sv * v[axis]));
      }
      vertices.push(...normal, uvx, uvy);
    }
    const first = face * 4;
    indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
  });

  return new Mesh({
    label: 'cube',
    description: {
      vertexBuffers: [
        {
          stride: 32,
          stepMode: 'vertex',
          attributes: [
            { semantic: 'position', format: 'float32x3', offset: 0 },
            { semantic: 'normal', format: 'float32x3', offset: 12 },
            { semantic: 'uv', format: 'float32x2', offset: 24 },
          ],
        },
      ],
      vertexCount: 24,
      indexBuffer: { format: 'uint16', count: indices.length },
    },
    vertices: [new Float32Array(vertices)],
    indices: new Uint16Array(indices),
  });
}

// Rotation of `angle` radians around a unit axis, as a quaternion.
export const axisAngle = (x: number, y: number, z: number, angle: number) => {
  const s = Math.sin(angle / 2);
  return { x: x * s, y: y * s, z: z * s, w: Math.cos(angle / 2) };
};

// An engine mesh from the interleaved data of the OBJ importer: position,
// then normal and uv when present. Indices are 32-bit beyond 65 535 vertices.
export function meshFromObj(data: MeshData, label?: string): Mesh {
  const attributes: MeshAttributeDescription[] = [
    { semantic: 'position', format: 'float32x3', offset: 0 },
  ];
  let offset = 12;
  if (data.hasNormals) {
    attributes.push({ semantic: 'normal', format: 'float32x3', offset });
    offset += 12;
  }
  if (data.hasUVs) {
    attributes.push({ semantic: 'uv', format: 'float32x2', offset });
  }

  const vertexCount = data.vertices.length / data.stride;
  const wide = vertexCount > 0xffff;
  return new Mesh({
    label,
    description: {
      vertexBuffers: [
        { stride: data.stride * 4, stepMode: 'vertex', attributes },
      ],
      vertexCount,
      indexBuffer: {
        format: wide ? 'uint32' : 'uint16',
        count: data.indices.length,
      },
    },
    vertices: [new Float32Array(data.vertices)],
    indices: wide
      ? new Uint32Array(data.indices)
      : new Uint16Array(data.indices),
  });
}
