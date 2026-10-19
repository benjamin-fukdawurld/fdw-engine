import { describe, expect, it } from 'vitest';
import { mergeKey, mergeMeshes } from './merge';
import { Mesh } from './Mesh';

// A triangle in the plane z = 0, facing +z: positions, normals, uvs
// interleaved, and a tangent along +x.
const triangle = (label = 'triangle', indexed = true) =>
  new Mesh({
    label,
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
        {
          stride: 16,
          stepMode: 'vertex',
          attributes: [{ semantic: 'tangent', format: 'float32x4', offset: 0 }],
        },
      ],
      vertexCount: 3,
      ...(indexed ? { indexBuffer: { format: 'uint16', count: 3 } } : {}),
    },
    vertices: [
      new Float32Array([
        0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 0, 1,
      ]),
      new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]),
    ],
    ...(indexed ? { indices: new Uint16Array([0, 1, 2]) } : {}),
  });

const translation = (x: number, y: number, z: number) => [
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  x,
  y,
  z,
  1,
];

// The attribute of a merged vertex, as floats.
const read = (mesh: Mesh, semantic: string, vertex: number) => {
  const buffer = mesh.description.vertexBuffers[0];
  const attribute = buffer.attributes.find((a) => a.semantic === semantic);
  if (!attribute) {
    throw new Error(`no ${semantic}`);
  }
  const data = mesh.vertices[0];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const size = Number(/x(\d)$/.exec(attribute.format)?.[1] ?? 1);
  return Array.from({ length: size }, (_, i) =>
    view.getFloat32(vertex * buffer.stride + attribute.offset + i * 4, true),
  );
};

describe('mergeMeshes', () => {
  it('puts the meshes in world space, with the identifier of each per vertex', () => {
    const merged = mergeMeshes([
      { mesh: triangle(), matrix: translation(10, 0, 0), id: 1 },
      { mesh: triangle(), matrix: translation(0, 5, 0), id: 2 },
    ]);
    expect(merged.description.vertexCount).toBe(6);
    expect(Array.from(merged.indices ?? [])).toEqual([0, 1, 2, 3, 4, 5]);
    expect(read(merged, 'position', 1)).toEqual([11, 0, 0]);
    expect(read(merged, 'position', 5)).toEqual([0, 6, 0]);
    expect(read(merged, 'uv', 2)).toEqual([0, 1]);
    expect(Array.from(merged.vertices[1] as Uint32Array)).toEqual([
      1, 1, 1, 2, 2, 2,
    ]);
    expect(merged.description.vertexBuffers[1].attributes[0]).toMatchObject({
      semantic: 'objectId',
      format: 'uint32',
    });
  });

  it('turns the normals and the tangents, and the faces of a mirror back', () => {
    // A quarter turn around y, then a mirror along x.
    const turn = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1];
    const mirror = [-2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const merged = mergeMeshes(
      [
        { mesh: triangle(), matrix: turn },
        { mesh: triangle('flat', false), matrix: mirror },
      ],
      { ids: false },
    );
    expect(merged.description.vertexBuffers).toHaveLength(1);
    const close = (values: number[]) => values.map((v) => v + 0);
    // +z turns to +x; the tangent +x to -z.
    expect(close(read(merged, 'normal', 0))).toEqual([1, 0, 0]);
    expect(close(read(merged, 'tangent', 0))).toEqual([0, 0, -1, 1]);
    // The mirror: the normal stays +z, normalized, the bitangent flips and
    // so does the winding.
    expect(close(read(merged, 'normal', 3))).toEqual([0, 0, 1]);
    expect(close(read(merged, 'tangent', 3))).toEqual([-1, 0, 0, -1]);
    expect(Array.from(merged.indices ?? [])).toEqual([0, 1, 2, 3, 5, 4]);
  });

  it('needs meshes of the same attributes', () => {
    const plain = new Mesh({
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
    expect(mergeKey(plain)).toBe('position:float32x3');
    expect(mergeKey(triangle())).toBe(
      'normal:float32x3,position:float32x3,tangent:float32x4,uv:float32x2',
    );
    expect(() =>
      mergeMeshes([
        { mesh: triangle(), matrix: translation(0, 0, 0) },
        { mesh: plain, matrix: translation(0, 0, 0) },
      ]),
    ).toThrow(/other attributes/);
  });

  it('leaves out what cannot be merged', () => {
    const lines = new Mesh({
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
        vertexCount: 2,
        topology: 'line-list',
      },
      vertices: [new Float32Array(6)],
    });
    const halfPositions = new Mesh({
      description: {
        vertexBuffers: [
          {
            stride: 8,
            stepMode: 'vertex',
            attributes: [
              { semantic: 'position', format: 'float16x4', offset: 0 },
            ],
          },
        ],
        vertexCount: 1,
      },
      vertices: [new Uint16Array(4)],
    });
    expect(mergeKey(lines)).toBeUndefined();
    expect(mergeKey(halfPositions)).toBeUndefined();
  });

  it('switches to 32-bit indices past 65 535 vertices', () => {
    const big = new Mesh({
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
        vertexCount: 40_002,
      },
      vertices: [new Float32Array(40_002 * 3)],
    });
    const parts = [0, 1].map(() => ({
      mesh: big,
      matrix: translation(0, 0, 0),
    }));
    const merged = mergeMeshes(parts);
    expect(merged.description.indexBuffer?.format).toBe('uint32');
    expect(merged.indices?.[40_002]).toBe(40_002);
  });
});
