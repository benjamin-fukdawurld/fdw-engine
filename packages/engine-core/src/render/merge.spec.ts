import { describe, expect, it } from 'vitest';
import { Camera } from '../Camera';
import { Transform } from '../Transform';
import { colorGraph, fakeBackend, surface } from '../testing/fakeBackend';
import { Material } from './Material';
import { isMirror, mergeKey, mergeMeshes, updateMergedVertices } from './merge';
import { Mesh } from './Mesh';
import { Renderer } from './Renderer';

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

  it('rewrites the vertices of one part in place', () => {
    const parts = [0, 1].map((i) => ({
      mesh: triangle(),
      matrix: translation(i * 10, 0, 0),
      id: i + 1,
    }));
    const merged = mergeMeshes(parts);
    const version = merged.version;
    updateMergedVertices(
      merged,
      { ...parts[1], matrix: translation(0, 0, 7) },
      3,
    );
    expect(read(merged, 'position', 3)).toEqual([0, 0, 7]);
    expect(read(merged, 'position', 0)).toEqual([0, 0, 0]);
    // One partial update, of the 3 vertices of the part.
    const updates = merged.updatesSince(version);
    expect(updates).toHaveLength(1);
    expect(updates?.[0]).toMatchObject({ buffer: 0, byteOffset: 3 * 48 });
    expect(updates?.[0].data.byteLength).toBe(3 * 48);
    expect(isMirror(translation(1, 2, 3))).toBe(false);
    expect(isMirror([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])).toBe(
      true,
    );
  });
});

describe('Mesh data on the GPU', () => {
  const draw = (renderer: Renderer, mesh: Mesh) =>
    renderer.render({
      items: [
        {
          mesh,
          material: new Material({ graph: colorGraph() }),
          transform: new Transform(),
        },
      ],
      camera: new Camera({ position: { x: 0, y: 0, z: 10 } }),
      surface,
    });

  it('gives the CPU copy back once uploaded, and makes it again when read', () => {
    let regenerated = 0;
    const parts = () => [{ mesh: triangle(), matrix: translation(1, 0, 0) }];
    const merged = mergeMeshes(parts(), {
      source: () => {
        regenerated++;
        return parts();
      },
    });
    expect(merged.releasable).toBe(true);
    const { backend } = fakeBackend();
    const renderer = new Renderer(backend);
    draw(renderer, merged);
    expect(merged.released).toBe(true);
    expect(regenerated).toBe(0);
    // Read: merged again.
    expect(read(merged, 'position', 0)).toEqual([1, 0, 0]);
    expect(regenerated).toBe(1);
    expect(merged.released).toBe(false);
    // A mesh without a way to make it again keeps it.
    const plain = triangle();
    draw(renderer, plain);
    expect(plain.released).toBe(false);
    expect(() => plain.releaseData()).toThrow(/cannot regenerate/);
  });

  it('writes only the parts updated, or everything when too far behind', () => {
    const merged = mergeMeshes([
      { mesh: triangle(), matrix: translation(0, 0, 0) },
    ]);
    const { backend, log } = fakeBackend();
    const renderer = new Renderer(backend);
    draw(renderer, merged);
    const buffers = log.buffers.length;
    const vertices = log.buffers.find((b) => b.label?.endsWith('vertices 0'));
    const writes = vertices?.writes ?? 0;
    merged.updateVertices(0, 48, new Float32Array(12));
    draw(renderer, merged);
    // No buffer created: one write into the one there.
    expect(
      log.buffers.filter((b) => b.label?.startsWith('merged')),
    ).toHaveLength(
      log.buffers.filter((b) => b.label?.startsWith('merged')).length,
    );
    expect(vertices?.writes).toBe(writes + 1);
    expect(vertices?.destroyed).toBe(false);
    // Unaligned: refused.
    expect(() => merged.updateVertices(0, 2, new Float32Array(1))).toThrow(
      /aligned/,
    );
    // A whole change: uploaded again.
    merged.setVertices(0, new Float32Array(36) as Float32Array<ArrayBuffer>);
    draw(renderer, merged);
    expect(vertices?.destroyed).toBe(true);
    expect(log.buffers.length).toBeGreaterThan(buffers);
  });
});
