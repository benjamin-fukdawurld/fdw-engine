import { Frustum } from '@fdw/engine-geometry';
import { describe, expect, it } from 'vitest';
import { LevelSelection } from './levels';
import { patchGrid } from './patches';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const options = { edgePixels: 8, minLevel: 0, maxLevel: 6, grow: 0 };
// 1000 pixels per unit at a distance of 1.
const from = (x: number, y: number, z: number) => ({
  position: [x, y, z] as const,
  pixelScale: 1000,
  orthographic: false,
});

describe('LevelSelection', () => {
  it('shares the edges between neighbors', () => {
    const patches = patchGrid({ width: 4, depth: 2, columns: 2, rows: 1 });
    // 7 edges: 2 × 3 along X, 3 along Z, the middle one shared.
    expect(patches.edgeCount).toBe(7);
    // The edge s = 1 of the first patch is the edge s = 0 of the second.
    expect(patches.edges[4 + 3]).toBe(patches.edges[1]);
  });

  it('refines the patches near the camera, each at the finest level of its edges', () => {
    const patches = patchGrid({ width: 64, depth: 4, columns: 16, rows: 1 });
    const selection = new LevelSelection(patches).update(
      identity,
      from(-31, 10, 0),
      options
    );
    const levels = Array.from(selection.levels);
    expect(levels[0]).toBeGreaterThan(levels[15]);
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i]).toBeLessThanOrEqual(levels[i - 1]);
    }
    levels.forEach((level, patch) => {
      const edges = Array.from(
        patches.edges.subarray(patch * 4, patch * 4 + 4)
      );
      expect(level).toBe(
        Math.max(...edges.map((edge) => selection.edgeLevels[edge]))
      );
    });
    expect(selection.drawn).toBe(16);
    expect(Array.from(selection.counts).reduce((a, b) => a + b)).toBe(16);
  });

  it('chooses as many quads as the edge covers pixels, within the bounds', () => {
    const patches = patchGrid({ width: 1, depth: 1, columns: 1, rows: 1 });
    const level = (distance: number, bounds = {}) =>
      new LevelSelection(patches).update(identity, from(0, distance, 0), {
        ...options,
        ...bounds,
      }).levels[0];
    // 1 unit at a distance of 10: 100 pixels, 12.5 edges of 8 pixels → 16.
    expect(level(10)).toBe(4);
    expect(level(1000)).toBe(0);
    expect(level(1000, { minLevel: 2 })).toBe(2);
    expect(level(0.01)).toBe(6);
    expect(level(0.01, { maxLevel: 3 })).toBe(3);
  });

  it('chooses the same level everywhere in orthographic', () => {
    const patches = patchGrid({ width: 8, depth: 8, columns: 4, rows: 4 });
    const selection = new LevelSelection(patches).update(
      identity,
      { position: [100, 100, 100], pixelScale: 64, orthographic: true },
      options
    );
    // 2 units, 128 pixels, 16 edges.
    expect(new Set(selection.levels)).toEqual(new Set([4]));
  });

  it('leaves out the patches outside of the frustum, grown by the displacement', () => {
    const patches = patchGrid({ width: 8, depth: 2, columns: 4, rows: 1 });
    // The planes x >= 0.5, then x <= 1.5 (normals inside), and far around.
    const frustum = new Frustum().setPlanes([
      1, 0, 0, -0.5, -1, 0, 0, 1.5, 0, 1, 0, 100, 0, -1, 0, 100, 0, 0, 1, 100,
      0, 0, -1, 100,
    ]);
    const view = { ...from(0, 10, 0), frustum };
    const selection = new LevelSelection(patches).update(
      identity,
      view,
      options
    );
    // Patches from x = -4 to 4, 2 wide: only [0, 2] is in, until they grow.
    expect(Array.from(selection.levels).map((level) => level >= 0)).toEqual([
      false,
      false,
      true,
      false,
    ]);
    expect(selection.drawn).toBe(1);
    const grown = selection.update(identity, view, { ...options, grow: 0.6 });
    expect(grown.drawn).toBe(3);
  });

  it('follows the world matrix', () => {
    const patches = patchGrid({ width: 1, depth: 1, columns: 1, rows: 1 });
    const scaled = [4, 0, 0, 0, 0, 4, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1];
    const level = (matrix: number[]) =>
      new LevelSelection(patches).update(matrix, from(0, 40, 0), options)
        .levels[0];
    expect(level(scaled)).toBe(level(identity) + 2);
  });
});
