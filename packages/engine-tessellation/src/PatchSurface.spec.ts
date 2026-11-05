import { Camera, Material, Renderer } from '@fdw/engine-core';
import { fakeBackend, FakeBuffer, surface } from '@fdw/engine-core/testing';
import { BuiltinTypes, compile, GraphBuilder } from '@fdw/engine-shader';
import { describe, expect, it } from 'vitest';
import { DrawHeader, patchVertex, PatchValues } from './graph';
import { patchMesh } from './patchMesh';
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
  // The buffer of the draws as last written: its header, then the draws.
  const written = () => {
    const data = new Float32Array(
      (material.getValue(PatchValues.draws) as unknown as FakeBuffer).data,
    );
    return {
      header: data.subarray(0, DrawHeader * 4),
      draws: data.subarray(DrawHeader * 4),
    };
  };
  return { backend, log, written, material, patches, terrain, camera };
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
    const { written, terrain, camera, patches } = setup();
    terrain.update(camera, { width: 1000, height: 1000 });
    // Fine under the camera, coarser away from it.
    expect(
      terrain.stats.levels.filter((count) => count > 0).length,
    ).toBeGreaterThan(1);
    const stats = terrain.stats;
    expect(stats.drawn).toBe(16);
    const { header, draws } = written();
    const vertexStarts = [...header.subarray(0, 8)];
    const drawStarts = [...header.subarray(8, 16)];
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

  it('writes its draws into a buffer for every patch', () => {
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
    const buffer = material.getValue(
      PatchValues.draws,
    ) as unknown as FakeBuffer;
    expect(buffer.size).toBe((DrawHeader + 900) * 16);
    expect(buffer.data.byteLength).toBe((DrawHeader + 900) * 16);
    expect(log.textures.filter((t) => t.label?.endsWith('draws'))).toEqual([]);
  });

  it('chooses its levels on the GPU, where the backend culls there', () => {
    const { backend, log } = fakeBackend({
      objectTable: true,
      storageBuffers: true,
      compute: true,
      indirectDraw: true,
    });
    const patches = patchGrid({ width: 64, depth: 64, columns: 4, rows: 4 });
    const terrain = new PatchSurface(backend, {
      patches,
      material: new Material({ graph: terrainGraph(false) }),
      levels: 'gpu',
    });
    expect(terrain.gpu).toBe(true);
    const camera = new Camera({ position: { x: 0, y: 10, z: 0 } });
    terrain.update(camera, { width: 100, height: 100 });
    // 16 patches, 7 levels: 112 flags, a prefix sum of 7 steps.
    expect(log.dispatches.map((dispatch) => dispatch.pipeline)).toEqual([
      'patch levels edges',
      'patch levels flags',
      ...new Array(7).fill('patch levels scan'),
      'patch levels starts',
      'patch levels draws',
    ]);
    // Drawn indirectly, its vertex count copied from the GPU.
    log.draws.length = 0;
    const renderer = new Renderer(backend);
    renderer.render({ items: [terrain], camera, surface });
    expect(log.draws).toHaveLength(1);
    expect(log.draws[0].indirect?.offset).toBe(0);
    expect(log.bufferCopies).toEqual([
      {
        from: 'patch surface counts',
        fromOffset: 0,
        to: 'vertex counts',
        toOffset: 0,
        size: 4,
      },
    ]);
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

describe('patchMesh', () => {
  it('cuts its quads along the diagonal of patchVertex', () => {
    // A saddle: the two diagonals of a quad give different surfaces.
    const mesh = patchMesh(
      patchGrid({ width: 2, depth: 2, columns: 1, rows: 1 }),
      { level: 1, displacement: { height: (u, v) => u * v, scale: 1 } },
    );
    const indices = mesh.indices as Uint32Array;
    // The corners of the vertices of a quad in patchVertex, (i, j) by
    // vertex: (0, 0) (0, 1) (1, 1), (0, 0) (1, 1) (1, 0).
    const corners = [
      [0, 0],
      [0, 1],
      [1, 1],
      [0, 0],
      [1, 1],
      [1, 0],
    ];
    const side = 3;
    const vertices = mesh.vertices[0] as Float32Array;
    const at = (vertex: number, k: number) => vertices[vertex * 8 + k];
    for (let quad = 0; quad < 4; quad++) {
      const qx = quad % 2;
      const qy = Math.floor(quad / 2);
      expect([...indices.subarray(quad * 6, quad * 6 + 6)]).toEqual(
        corners.map(([i, j]) => (qy + j) * side + qx + i),
      );
      // Their front on the side of the normal of the surface.
      for (let triangle = 0; triangle < 2; triangle++) {
        const [a, b, c] = indices.subarray(
          quad * 6 + triangle * 3,
          quad * 6 + triangle * 3 + 3,
        );
        const e1 = [0, 1, 2].map((k) => at(b, k) - at(a, k));
        const e2 = [0, 1, 2].map((k) => at(c, k) - at(a, k));
        const cross = [
          e1[1] * e2[2] - e1[2] * e2[1],
          e1[2] * e2[0] - e1[0] * e2[2],
          e1[0] * e2[1] - e1[1] * e2[0],
        ];
        const facing = [0, 1, 2].reduce(
          (sum, k) => sum + cross[k] * at(a, 3 + k),
          0,
        );
        expect(facing).toBeGreaterThan(0);
      }
    }
  });
});
