import { describe, expect, it } from 'vitest';
import type {
  GpuTexture,
  GpuTextureRegion,
  RenderBackend,
} from '@fdw/engine-backend';
import { pickIds } from './picking';

// A 4 × 2 texture of identifiers, rows from the top, and the regions read.
const ids = [
  [0, 3, 3, 7],
  [5, 0, 3, 0],
];
const texture = (format = 'r32uint') =>
  ({
    type: '2d',
    format,
    dimensions: { width: 4, height: 2 },
    usage: ['render-attachment', 'copy-src'],
    destroy: () => undefined,
  }) as GpuTexture;
const backend = () => {
  const reads: GpuTextureRegion[] = [];
  return {
    reads,
    backend: {
      textures: {
        readTexture: async (_: GpuTexture, region: GpuTextureRegion) => {
          reads.push(region);
          const values: number[] = [];
          for (let y = region.y; y < region.y + region.height; y++) {
            values.push(...ids[y].slice(region.x, region.x + region.width));
          }
          return new Uint32Array(values).buffer;
        },
      },
    } as unknown as RenderBackend,
  };
};

describe('pickIds', () => {
  it('reads the pixel under a point', async () => {
    const { backend: b, reads } = backend();
    expect(await pickIds(b, texture(), { x: 3.6, y: 0.2 })).toEqual([7]);
    expect(reads).toEqual([{ x: 3, y: 0, width: 1, height: 1 }]);
    // Nothing there.
    expect(await pickIds(b, texture(), { x: 0, y: 0 })).toEqual([]);
  });

  it('gives the distinct identifiers of a rectangle, in order', async () => {
    const { backend: b } = backend();
    expect(
      await pickIds(b, texture(), { x: 0, y: 0, width: 3, height: 2 }),
    ).toEqual([3, 5]);
    // Dragged up and left, from the bottom right corner.
    expect(
      await pickIds(b, texture(), { x: 4, y: 2, width: -2, height: -2 }),
    ).toEqual([3, 7]);
  });

  it('ignores the part of the region out of the texture', async () => {
    const { backend: b, reads } = backend();
    expect(
      await pickIds(b, texture(), { x: -2, y: 1, width: 4, height: 5 }),
    ).toEqual([5]);
    expect(reads).toEqual([{ x: 0, y: 1, width: 2, height: 1 }]);
    expect(await pickIds(b, texture(), { x: 10, y: 0 })).toEqual([]);
    expect(await pickIds(b, texture(), { x: -1, y: -1 })).toEqual([]);
    expect(reads).toHaveLength(1);
  });

  it('only reads textures of identifiers', async () => {
    const { backend: b } = backend();
    await expect(
      pickIds(b, texture('rgba8unorm'), { x: 0, y: 0 }),
    ).rejects.toThrow(/textures of identifiers \(r32uint\), not rgba8unorm/);
  });
});
