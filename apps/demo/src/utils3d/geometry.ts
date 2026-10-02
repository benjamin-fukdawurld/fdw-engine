import { Mesh } from '@fdw/engine-core';

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
