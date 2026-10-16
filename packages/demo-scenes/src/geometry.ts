import { Mesh } from '@fdw/engine-core';

// A sphere of radius 0.5 centered on the origin, with positions, normals and
// uvs, and counter-clockwise faces seen from outside.
export function createSphere(segments = 32, rings = 16): Mesh {
  const vertices: number[] = [];
  const indices: number[] = [];
  for (let ring = 0; ring <= rings; ring++) {
    const theta = (ring / rings) * Math.PI;
    for (let segment = 0; segment <= segments; segment++) {
      const phi = (segment / segments) * 2 * Math.PI;
      const normal = [
        Math.sin(theta) * Math.sin(phi),
        Math.cos(theta),
        Math.sin(theta) * Math.cos(phi),
      ];
      vertices.push(
        ...normal.map((n) => n * 0.5),
        ...normal,
        segment / segments,
        ring / rings,
      );
    }
  }
  const row = segments + 1;
  for (let ring = 0; ring < rings; ring++) {
    for (let segment = 0; segment < segments; segment++) {
      const a = ring * row + segment;
      const b = a + row;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return new Mesh({
    label: 'sphere',
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
      vertexCount: vertices.length / 8,
      indexBuffer: { format: 'uint16', count: indices.length },
    },
    vertices: [new Float32Array(vertices)],
    indices: new Uint16Array(indices),
  });
}

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

// A square of side 1 in the xz plane, facing +y, centered on the origin,
// split in segments × segments cells: enough vertices to displace them
// (displacement mapping). Positions, normals and uvs (u along +x, v along
// +z: the image seen from above, its top towards -z).
export function createPlane(segments = 1): Mesh {
  const vertices: number[] = [];
  const indices: number[] = [];
  for (let row = 0; row <= segments; row++) {
    for (let column = 0; column <= segments; column++) {
      const u = column / segments;
      const v = row / segments;
      vertices.push(u - 0.5, 0, v - 0.5, 0, 1, 0, u, v);
    }
  }
  const stride = segments + 1;
  for (let row = 0; row < segments; row++) {
    for (let column = 0; column < segments; column++) {
      const a = row * stride + column;
      const b = a + stride;
      // Counter-clockwise seen from +y.
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const count = vertices.length / 8;
  return new Mesh({
    label: 'plane',
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
      vertexCount: count,
      indexBuffer: {
        format: count > 65535 ? 'uint32' : 'uint16',
        count: indices.length,
      },
    },
    vertices: [new Float32Array(vertices)],
    indices:
      count > 65535 ? new Uint32Array(indices) : new Uint16Array(indices),
  });
}

// Rotation of `angle` radians around a unit axis, as a quaternion.
export const axisAngle = (x: number, y: number, z: number, angle: number) => {
  const s = Math.sin(angle / 2);
  return { x: x * s, y: y * s, z: z * s, w: Math.cos(angle / 2) };
};
