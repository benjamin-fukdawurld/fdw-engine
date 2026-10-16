import { Camera, Material, Renderer } from '@fdw/engine-core';
import { fakeBackend, surface } from '@fdw/engine-core/testing';
import { BuiltinTypes, compile, GraphBuilder } from '@fdw/engine-shader';
import { describe, expect, it } from 'vitest';
import { patchVertex, PatchValues } from './graph';
import { patchGrid } from './patches';
import { PatchSurface } from './PatchSurface';

const terrainGraph = (displaced = true) => {
  const g = new GraphBuilder('terrain');
  const vertex = patchVertex(
    g,
    displaced
      ? {
          displacement: {
            texture: g.texture('heightMap'),
            sampler: g.sampler('heightSampler'),
            scale: 2,
          },
        }
      : {},
  );
  g.surface({
    shadingModel: 'phong',
    baseColor: g.call('std.vec3', {
      x: vertex.height,
      y: g.attribute('uv', BuiltinTypes.vec2f).swizzle('x'),
      z: 0.5,
    }),
  });
  return g.build();
};

const setup = (options: { cull?: boolean; displacement?: number } = {}) => {
  const { backend, log } = fakeBackend({ objectTable: true });
  const writes: Float32Array[] = [];
  backend.textures.writeTexture = (_texture, data) => {
    writes.push(new Float32Array((data as Float32Array).slice()));
  };
  const material = new Material({
    graph: terrainGraph(),
    values: {
      heightMap: backend.textures.createTexture({
        type: '2d',
        format: 'rgba8unorm',
        dimensions: { width: 1, height: 1 },
      }),
      heightSampler: backend.textures.createSampler({}),
    },
  });
  const patches = patchGrid({ width: 64, depth: 4, columns: 16, rows: 1 });
  const terrain = new PatchSurface(backend, {
    patches,
    material,
    cull: options.cull ?? false,
    displacement: options.displacement ?? 0,
  });
  // Above the first patch; the levels come from its projection data (45°).
  const camera = new Camera({ position: { x: -31, y: 10, z: 0 } });
  return { backend, log, writes, material, patches, terrain, camera };
};

describe('PatchSurface', () => {
  it('compiles without vertex attribute', () => {
    for (const displaced of [true, false]) {
      const program = compile(terrainGraph(displaced), {
        vertexAttributes: [],
        capabilities: { objectTable: true },
      });
      expect(program.vertexInputs).toEqual([]);
    }
  });

  it('draws the patches sorted by level, with the steps of their edges', () => {
    const { writes, material, terrain, camera, patches } = setup();
    terrain.update(camera, { width: 1000, height: 1000 });
    // Fine under the camera, coarser away from it.
    expect(
      terrain.stats.levels.filter((count) => count > 0).length,
    ).toBeGreaterThan(1);
    const stats = terrain.stats;
    expect(stats.drawn).toBe(16);
    const draws = writes[writes.length - 1];
    const vertexStarts = [
      ...(material.getValue(PatchValues.vertexStarts[0]) as number[]),
      ...(material.getValue(PatchValues.vertexStarts[1]) as number[]),
    ];
    const drawStarts = [
      ...(material.getValue(PatchValues.drawStarts[0]) as number[]),
      ...(material.getValue(PatchValues.drawStarts[1]) as number[]),
    ];
    let vertices = 0;
    let first = 0;
    for (let level = 0; level <= 6; level++) {
      expect(vertexStarts[level]).toBe(vertices);
      expect(drawStarts[level]).toBe(first);
      for (let i = first; i < first + stats.levels[level]; i++) {
        const patch = draws[i * 4];
        // Each edge on a grid at most as fine as the patch.
        const steps = [
          draws[i * 4 + 1] % 128,
          Math.floor(draws[i * 4 + 1] / 128),
          draws[i * 4 + 2] % 128,
          Math.floor(draws[i * 4 + 2] / 128),
        ];
        steps.forEach((step) => {
          expect(Number.isInteger(Math.log2(step))).toBe(true);
          expect(step).toBeLessThanOrEqual(2 ** level);
        });
        // The finest edge sets the level of the patch.
        expect(Math.min(...steps)).toBe(1);
        expect(patch).toBeGreaterThanOrEqual(0);
        expect(patch).toBeLessThan(patches.count);
      }
      first += stats.levels[level];
      vertices += stats.levels[level] * 6 * 4 ** level;
    }
    expect(vertexStarts[7]).toBeGreaterThan(vertices);
    expect(terrain.mesh.description.vertexCount).toBe(vertices);
    expect(stats.triangles).toBe(vertices / 3);
    // Every patch once.
    const drawn = Array.from({ length: 16 }, (_, i) => draws[i * 4]).sort(
      (a, b) => a - b,
    );
    expect(drawn).toEqual(Array.from({ length: 16 }, (_, i) => i));
  });

  it('is drawn in one draw, without vertex buffer', () => {
    const { backend, log, terrain, camera } = setup();
    const renderer = new Renderer(backend);
    terrain.update(camera, { width: 100, height: 100 });
    renderer.render({ items: [terrain], camera, surface });
    const draws = log.draws.filter((draw) => draw.count > 0);
    expect(draws).toHaveLength(1);
    expect(draws[0].count).toBe(terrain.mesh.description.vertexCount);
    expect(draws[0].indexed).toBe(false);
    expect(log.calls.setVertexBuffer).toBe(0);
  });

  it('grows its bounds by the displacement, through its matrix', () => {
    const { terrain } = setup({ displacement: 2 });
    expect(Array.from(terrain.bounds.min)).toEqual([-34, -2, -4]);
    expect(Array.from(terrain.bounds.max)).toEqual([34, 2, 4]);
    terrain.setMatrix([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 1, 0, 0, 1]);
    expect(Array.from(terrain.bounds.min)).toEqual([-67, -4, -8]);
    expect(terrain.world.version).toBe(1);
  });

  it('grows the texture of the draws', () => {
    const { backend, log } = fakeBackend({ objectTable: true });
    const patches = patchGrid({ width: 64, depth: 64, columns: 30, rows: 30 });
    const material = new Material({ graph: terrainGraph() });
    const terrain = new PatchSurface(backend, {
      patches,
      material,
      cull: false,
    });
    terrain.update(new Camera({ position: { x: 0, y: 1000, z: 0 } }), {
      width: 10,
      height: 10,
    });
    expect(terrain.stats.drawn).toBe(900);
    const draws = log.textures.filter((t) => t.label?.endsWith('draws'));
    expect(draws.map((t) => t.dimensions.height)).toEqual([1, 4]);
    expect(material.getValue(PatchValues.draws)).toMatchObject({
      dimensions: { width: 256, height: 4 },
    });
  });

  it('refuses levels out of bounds', () => {
    const { backend } = fakeBackend();
    const options = {
      patches: patchGrid({ width: 1, depth: 1, columns: 1, rows: 1 }),
      material: new Material({ graph: terrainGraph() }),
    };
    expect(
      () => new PatchSurface(backend, { ...options, maxLevel: 7 }),
    ).toThrow(/from 0 to 6/);
    expect(
      () => new PatchSurface(backend, { ...options, minLevel: 3, maxLevel: 2 }),
    ).toThrow();
  });
});
