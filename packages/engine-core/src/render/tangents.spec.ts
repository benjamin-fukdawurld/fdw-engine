import { describe, expect, it } from 'vitest';
import { Mesh } from './Mesh';
import { computeTangents } from './tangents';

// A quad in the z = 0 plane facing +z, with uvs (v pointing down, like
// images): u grows along +x, v along -y.
const quad = (uvs: number[][]) =>
  new Mesh({
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
      vertexCount: 4,
      indexBuffer: { format: 'uint16', count: 6 },
    },
    vertices: [
      new Float32Array(
        [
          [-0.5, -0.5],
          [0.5, -0.5],
          [0.5, 0.5],
          [-0.5, 0.5],
        ].flatMap(([x, y], i) => [x, y, 0, 0, 0, 1, ...uvs[i]]),
      ),
    ],
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
  });

const tangentsOf = (mesh: Mesh) => [
  ...(mesh.vertices[mesh.vertices.length - 1] as Float32Array),
];

describe('computeTangents', () => {
  it('points along +u, with the bitangent up in the image', () => {
    const mesh = computeTangents(
      quad([
        [0, 1],
        [1, 1],
        [1, 0],
        [0, 0],
      ]),
    );
    expect(mesh.description.vertexBuffers[1].attributes).toEqual([
      { semantic: 'tangent', format: 'float32x4', offset: 0 },
    ]);
    // (1, 0, 0), and cross(n, t) = +y is up in the image: w = 1.
    for (let i = 0; i < 4; i++) {
      expect(tangentsOf(mesh).slice(i * 4, i * 4 + 4)).toEqual([1, 0, 0, 1]);
    }
    expect(mesh.indices).toBeDefined();
  });

  it('gives w = -1 for a mirrored uv mapping', () => {
    // v grows along +y: the image is upside down.
    const mesh = computeTangents(
      quad([
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ]),
    );
    expect(tangentsOf(mesh).slice(0, 4)).toEqual([1, 0, 0, -1]);
  });

  it('needs positions, normals and uvs', () => {
    const mesh = new Mesh({
      description: {
        vertexBuffers: [
          {
            stride: 12,
            stepMode: 'vertex',
            attributes: [
              { semantic: 'position', format: 'float32x3', offset: 0 },
            ],
          },
        ],
        vertexCount: 3,
      },
      vertices: [new Float32Array(9)],
    });
    expect(() => computeTangents(mesh)).toThrow(/normal and uv/);
  });
});
