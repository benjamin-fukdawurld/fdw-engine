import { describe, expect, it } from 'vitest';
import { Camera } from '../Camera';
import { Transform } from '../Transform';
import { colorGraph, fakeBackend, surface } from '../testing/fakeBackend';
import { Material } from './Material';
import { Mesh } from './Mesh';
import { MeshArena, RangeAllocator } from './MeshArena';
import { Renderer } from './Renderer';

describe('RangeAllocator', () => {
  it('hands ranges out first fit, and merges those given back', () => {
    const ranges = new RangeAllocator(10);
    expect(ranges.allocate(4)).toBe(0);
    expect(ranges.allocate(4)).toBe(4);
    expect(ranges.allocate(4)).toBeUndefined();
    ranges.free(0, 4);
    expect(ranges.allocate(2)).toBe(0);
    ranges.free(0, 2);
    ranges.free(4, 4);
    // 0 to 10 free again, in one range.
    expect(ranges.available).toBe(10);
    expect(ranges.allocate(10)).toBe(0);
  });

  it('grows, the new elements free after the others', () => {
    const ranges = new RangeAllocator(4);
    expect(ranges.allocate(3)).toBe(0);
    ranges.grow(8);
    expect(ranges.allocate(5)).toBe(3);
    expect(ranges.capacity).toBe(8);
  });
});

// A square of two triangles, indexed, at a size.
const square = (size: number, arena?: MeshArena) =>
  new Mesh({
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
      vertexCount: 4,
      indexBuffer: { format: 'uint16', count: 6 },
    },
    vertices: [
      new Float32Array([0, 0, 0, size, 0, 0, size, size, 0, 0, size, 0]),
    ],
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
    ...(arena ? { arena } : {}),
  });

describe('MeshArena', () => {
  const setup = (capabilities: { drawIndirectCount?: boolean } = {}) => {
    const { backend, log } = fakeBackend({
      maxVaryings: 16,
      storageBuffers: true,
      compute: true,
      objectTable: true,
      indirectDraw: true,
      multiDrawIndirect: true,
      ...capabilities,
    });
    const renderer = new Renderer(backend);
    const arena = new MeshArena({ label: 'squares' });
    const material = new Material({ graph: colorGraph() });
    const items = [1, 2, 3].map((size, i) => ({
      mesh: square(size, arena),
      material,
      transform: new Transform({ position: { x: i - 1, y: 0, z: 0 } }),
    }));
    const camera = new Camera({ position: { x: 0, y: 0, z: 10 } });
    return { backend, log, renderer, items, camera };
  };

  it('places its meshes in shared buffers, drawn indirectly', () => {
    const { log, renderer, items, camera } = setup();
    renderer.render({ items, camera, surface });
    // One vertex and one index buffer for the three meshes.
    const created = log.buffers.map((buffer) => buffer.label);
    expect(created.filter((label) => label?.startsWith('squares'))).toEqual([
      'squares 0 vertices 0',
      'squares 0 indices',
    ]);
    // Without the culling on the GPU: a draw each, from its place.
    expect(log.draws.map((draw) => draw.indirect?.offset)).toEqual([0, 20, 40]);
  });

  it('draws the runs of its meshes in one multiple draw, culled on the GPU', () => {
    const { log, renderer, items, camera } = setup({ drawIndirectCount: true });
    renderer.render({ items, camera, surface, gpuCulling: true });
    expect(log.draws).toHaveLength(1);
    const { indirect } = log.draws[0];
    expect(indirect?.maxCount).toBe(3);
    // The runs with instances packed, their count written by the GPU.
    expect(indirect?.buffer.label).toBe('culling scene opaque packed');
    expect(indirect?.count?.buffer.label).toBe('culling scene opaque counts');
    expect(log.dispatches.map((dispatch) => dispatch.pipeline)).toEqual(
      expect.arrayContaining(['culling non-empty runs', 'culling pack']),
    );
  });

  it('draws every run without a count read by the GPU', () => {
    const { log, renderer, items, camera } = setup();
    renderer.render({ items, camera, surface, gpuCulling: true });
    expect(log.draws).toHaveLength(1);
    expect(log.draws[0].indirect?.buffer.label).toBe(
      'culling scene opaque arguments',
    );
    expect(log.draws[0].indirect?.count).toBeUndefined();
  });
});
