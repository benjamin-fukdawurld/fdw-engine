import {
  installAssets,
  MaterialDataType,
  MeshDataType,
  ModelDataType,
  ModelType,
  TextureType,
  type Model,
  type ModelData,
} from '@fdw/engine-assets';
import { fakeBackend } from '@fdw/engine-core/testing';
import { ScenePhysics, Shapes } from '@fdw/engine-physics';
import {
  createRapierPhysics,
  type RapierPhysics,
} from '@fdw/engine-physics-rapier';
import {
  MemorySource,
  ResourceStore,
  type ResourceLoader,
} from '@fdw/engine-resources';
import { Scene } from '@fdw/engine-scene';
import { captureScene } from '@fdw/engine-scene-io';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildForest, type Forest } from './forest';
import { defineRock, levelCodecs, loadTpsLevel, saveTpsLevel } from './level';

let rapier: RapierPhysics;
beforeAll(async () => {
  rapier = await createRapierPhysics();
});

// "model" files: a JSON list of node names, each a triangle.
const modelFormat: ResourceLoader<ModelData> = {
  type: ModelDataType,
  async load(ctx) {
    const names = JSON.parse(await ctx.text()) as string[];
    ctx.provide(MaterialDataType, 'material/0', {
      kind: 'pbr',
      name: 'bark trunk',
      baseColor: [0.4, 0.3, 0.2, 1],
      metallic: 0,
      roughness: 1,
      emissive: [0, 0, 0],
      alphaMode: 'opaque',
      alphaCutoff: 0.5,
      doubleSided: false,
    });
    names.forEach((name, i) =>
      ctx.provide(MeshDataType, `mesh/${i}`, {
        name,
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
        vertices: [new Float32Array([0, 0, 0, 1, 0, 0, 0, 1 + i, 0])],
      }),
    );
    return {
      name: 'test',
      nodes: names.map((name, i) => ({ name, children: [], mesh: i })),
      roots: names.map((_, i) => i),
      meshes: names.map((_, i) => ({
        primitives: [{ mesh: `mesh/${i}`, material: 'material/0' }],
      })),
      skins: [],
      animations: [],
      cameras: [],
      lights: [],
    };
  },
};

const firs = ['a', 'b', 'c'].flatMap((k) =>
  [0, 1, 2].map((l) => `fir_${k}_LOD${l}`),
);
const files = {
  'forest/fir.glb': JSON.stringify(firs),
  'forest/fern.glb': JSON.stringify(['fern_0', 'fern_1', 'fern_2', 'fern_3']),
  'forest/grass.glb': JSON.stringify([
    'grass_0',
    'grass_2',
    'grass_3',
    'grass_5',
    'grass_6',
    'grass_7',
  ]),
  'forest/ground.img': 'img',
};

async function setup() {
  const { backend } = fakeBackend();
  const store = new ResourceStore({ warn: () => undefined });
  const mem = new MemorySource(files);
  store.mount('mem', mem, { default: true });
  installAssets(store, {
    backend,
    codecs: [
      {
        name: 'test',
        sniff: () => true,
        decode: async () => ({
          type: '2d',
          width: 1,
          height: 1,
          format: 'rgba8unorm',
          levels: [new Uint8Array(4)],
        }),
      },
    ],
  });
  store.registerLoader(modelFormat);
  const model = (name: string) =>
    store.load<Model>(ModelType, `forest/${name}.glb`).ready;
  const texture = (colorSpace: 'srgb' | 'linear') =>
    store.load(TextureType, 'forest/ground.img', { options: { colorSpace } })
      .ready;
  const ground = {
    color: (await texture('srgb')).texture,
    normal: (await texture('linear')).texture,
    roughness: (await texture('linear')).texture,
  };
  const models = {
    fir: await model('fir'),
    fern: await model('fern'),
    grass: await model('grass'),
    ground,
  };
  const rock = backend.textures.createTexture({
    type: '2d',
    format: 'rgba8unorm',
    dimensions: { width: 4, height: 4 },
  });
  defineRock(store, backend, rock);
  return { backend, store, mem, models, rock };
}

const options = {
  size: 160,
  playRadius: 30,
  treeSpacing: 12,
  treeRadius: 70,
  coverDensity: 0.01,
};

describe('the level of the TPS', () => {
  it('saves the forest, loaded back the same: nodes, batches, levels, terrain, bodies', async () => {
    const { backend, store, mem, models, rock } = await setup();
    const scene = new Scene();
    const physics = new ScenePhysics(scene, rapier.createWorld());
    const forest: Forest = buildForest(
      backend,
      scene,
      physics,
      models,
      rock,
      options,
    );
    expect(forest.treeCount).toBeGreaterThan(10);
    const written = await saveTpsLevel(
      backend,
      scene,
      store,
      forest,
      'forest/forest.scene.json',
      physics,
    );
    expect(written.map((f) => f.path)).toEqual([
      'forest/forest.scene.json',
      'forest/forest.scene.bin',
    ]);
    for (const file of written) mem.set(file.path, file.bytes);
    const json = JSON.parse(new TextDecoder().decode(written[0].bytes));
    // The firs by reference to their model; the ground and the rock too.
    expect(json.batches[0].mesh).toMatch(/^(fir|fern|grass)\.glb#mesh\/\d+$/);
    const ground = json.materials[0];
    expect(ground.values.rock).toEqual({
      texture: '../generated/rock.texture',
    });
    expect(ground.values.groundColor).toEqual({
      texture: 'ground.img',
      colorSpace: 'srgb',
    });

    const other = new Scene();
    const otherPhysics = new ScenePhysics(other, rapier.createWorld());
    const loaded = await loadTpsLevel(
      backend,
      other,
      store,
      'forest/forest.scene.json',
      otherPhysics,
    );
    expect(loaded.treeCount).toBe(forest.treeCount);
    expect(loaded.playRadius).toBe(forest.playRadius);
    expect(loaded.heightAt(3, 4)).toBeCloseTo(forest.heightAt(3, 4), 5);
    expect(loaded.lods.Lod.count).toBe(forest.lods.Lod.count);
    expect(otherPhysics.Body.count).toBe(physics.Body.count);
    // Captured again: the same data.
    const capture = (s: Scene, f: Forest, p: ScenePhysics) =>
      captureScene(s, {
        store,
        uri: 'mem:forest/forest.scene.json',
        codecs: levelCodecs(backend, s, f.lods, p),
      });
    expect(capture(other, loaded, otherPhysics)).toEqual(
      capture(scene, forest, physics),
    );
  });

  it('plays the same on the forest built and on the forest loaded', async () => {
    const { backend, store, mem, models, rock } = await setup();
    const run = async (load: boolean) => {
      const scene = new Scene();
      const physics = new ScenePhysics(scene, rapier.createWorld());
      if (load) {
        await loadTpsLevel(
          backend,
          scene,
          store,
          'forest/forest.scene.json',
          physics,
        );
      } else {
        const forest = buildForest(
          backend,
          scene,
          physics,
          models,
          rock,
          options,
        );
        for (const file of await saveTpsLevel(
          backend,
          scene,
          store,
          forest,
          'forest/forest.scene.json',
          physics,
        ))
          mem.set(file.path, file.bytes);
      }
      // Balls dropped on the slopes and against the trunks.
      const balls = Array.from({ length: 12 }, (_, i) =>
        physics.add(
          scene.root.add({
            position: { x: -30 + i * 5, y: 20, z: 10 - i * 2 },
          }),
          { type: 'dynamic', colliders: [{ shape: Shapes.sphere(0.5) }] },
        ),
      );
      for (let step = 0; step < 240; step++) physics.step(1 / 60);
      return balls.map((ball) => {
        const p = ball.position;
        return [p.x, p.y, p.z];
      });
    };
    const built = await run(false);
    const loaded = await run(true);
    expect(loaded).toEqual(built);
    // They moved: the test sees the ground.
    expect(built.some(([, y]) => y < 15)).toBe(true);
  });
});
