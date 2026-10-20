import { Material } from '@fdw/engine-core';
import {
  sharedSampler,
  TextureType,
  instantiate,
  ModelType,
} from '@fdw/engine-assets';
import { Scene } from '@fdw/engine-scene';
import { describe, expect, it } from 'vitest';
import { captureScene } from './capture';
import { SceneDataType, type SceneData } from './data';
import {
  migrateFdwScene,
  parseFdwScene,
  writeFdwScene,
  type ExportedFile,
} from './format';
import { installSceneIo } from './install';
import { instantiateScene } from './instantiate';
import { testStore, tintedGraph, triangle } from './testing';

const tree = JSON.stringify({
  name: 'tree',
  nodes: [],
  roots: [],
  meshes: [{ color: [0, 1, 0, 1] }],
});

async function level() {
  const context = testStore({
    'models/tree.model': tree,
    'red.img': 'img 1 1 255 0 0 255',
  });
  const { store, backend } = context;
  installSceneIo(store);
  const scene = new Scene();
  const texture = await store.load(TextureType, 'red.img').ready;
  const material = new Material({
    graph: tintedGraph(),
    values: {
      tint: [1, 0.5, 0.25],
      color: texture.texture,
      colorSampler: sharedSampler(backend, { minFilter: 'nearest' }),
    },
    label: 'ground',
  });
  const ground = scene.root.add({ name: 'ground', static: true });
  ground.setMesh(triangle('ground', 4), material);
  scene.createBatch({
    count: 20,
    mesh: triangle('pebble'),
    material,
    positions: Array.from({ length: 60 }, (_, i) => i / 3),
    name: 'pebble',
  });
  const model = await store.load(ModelType, 'models/tree.model').ready;
  instantiate(model, scene, { name: 'tree', position: { x: 3, y: 0, z: 1 } });
  return { ...context, scene };
}

const mount = (
  mem: ReturnType<typeof testStore>['mem'],
  files: readonly ExportedFile[],
) => {
  for (const file of files) mem.set(file.path, file.bytes);
};

describe('the fdw-scene format', () => {
  it('writes a scene as JSON and binary, read back the same', async () => {
    const { store, scene } = await level();
    const uri = 'levels/forest.scene.json';
    const data = captureScene(scene, { store, uri: `mem:${uri}` });
    const files = await writeFdwScene(data, uri);
    expect(files.map((f) => f.path)).toEqual([
      'levels/forest.scene.json',
      'levels/forest.scene.bin',
    ]);
    const json = JSON.parse(new TextDecoder().decode(files[0].bytes));
    expect(json).toMatchObject({
      format: 'fdw-scene',
      schemaVersion: 1,
      buffers: [{ uri: 'forest.scene.bin', byteLength: files[1].bytes.length }],
    });
    // The graph once, the materials by its index; the references relative.
    expect(json.graphs).toHaveLength(1);
    expect(json.materials[0].graph).toBe(0);
    const treeNode = json.nodes.find(
      (n: { name: string }) => n.name === 'tree',
    );
    expect(treeNode.instance.model).toBe('../models/tree.model');
    expect(json.materials[0].values.color).toEqual({ texture: '../red.img' });
    expect(json.batches[0].positions.$binary).toMatchObject({
      type: 'f32',
      length: 60,
    });
    const read = parseFdwScene(
      new TextDecoder().decode(files[0].bytes),
      files[1].bytes,
    );
    expect(read).toEqual(data);
  });

  it('writes the binary in the JSON when asked', async () => {
    const { store, scene } = await level();
    const data = captureScene(scene, { store });
    const files = await writeFdwScene(data, 'a.scene.json', {
      binary: 'embedded',
      indent: 0,
    });
    expect(files).toHaveLength(1);
    const { mem } = testStore();
    mount(mem, files);
    const other = testStore({ 'a.scene.json': files[0].bytes });
    installSceneIo(other.store);
    const loaded = await other.store.load(SceneDataType, 'a.scene.json').ready;
    expect(loaded.batches[0].positions).toEqual(data.batches[0].positions);
  });

  it('loads a scene through the store, its meshes and materials as sub-resources', async () => {
    const { store, mem, scene } = await level();
    const uri = 'levels/forest.scene.json';
    const data = captureScene(scene, { store, uri: `mem:${uri}` });
    mount(mem, await writeFdwScene(data, uri));
    const handle = store.load(SceneDataType, uri);
    const other = new Scene();
    const instance = await instantiateScene(handle, other, { store });
    handle.release();
    // The mesh of the store, a sub-resource of the scene.
    const ground = other.find('ground')!;
    expect(store.identify(other.MeshRenderer.mesh[ground.entity])?.uri).toBe(
      'mem:levels/forest.scene.json#mesh/0',
    );
    // Written again at the same place: the same data.
    const again = captureScene(other, {
      store,
      uri: `mem:${uri}`,
      root: instance.root,
    });
    expect(again).toEqual(data);
    instance.dispose();
    expect(ground.alive).toBe(false);
  });

  it('migrates the older versions, refuses the newer and the others', () => {
    const v1 = {
      format: 'fdw-scene',
      schemaVersion: 1,
      nodes: [{ label: 'a' }],
    };
    const migrated = migrateFdwScene(
      v1,
      {
        1: (doc) => ({
          ...doc,
          nodes: (doc['nodes'] as { label: string }[]).map((n) => ({
            name: n.label,
          })),
        }),
      },
      2,
    );
    expect(migrated).toEqual({
      format: 'fdw-scene',
      schemaVersion: 2,
      nodes: [{ name: 'a' }],
    });
    expect(() => migrateFdwScene({ ...v1, schemaVersion: 3 }, {}, 2)).toThrow(
      /newer than this engine/,
    );
    expect(() => migrateFdwScene(v1, {}, 2)).toThrow(
      /No migration from version 1/,
    );
    expect(() => migrateFdwScene({ format: 'gltf' })).toThrow(/Not a scene/);
    expect(() =>
      parseFdwScene({
        format: 'fdw-scene',
        schemaVersion: 1,
        nodes: [{ parent: 1 }, {}],
      }),
    ).toThrow(/parent must come before/);
  });

  it('cancels the loading of a scene with its last handle', async () => {
    const { store, mem, scene } = await level();
    const data: SceneData = captureScene(scene, {
      store,
      uri: 'mem:l.scene.json',
    });
    mount(mem, await writeFdwScene(data, 'l.scene.json'));
    const handle = store.load(SceneDataType, 'l.scene.json');
    handle.release();
    await expect(handle.ready).rejects.toMatchObject({ code: 'aborted' });
    // An instance cancelled while its resources load leaves nothing.
    const loading = store.load(SceneDataType, 'l.scene.json');
    const controller = new AbortController();
    const other = new Scene();
    const made = instantiateScene(loading, other, {
      store,
      signal: controller.signal,
    });
    controller.abort();
    await expect(made).rejects.toBeDefined();
    loading.release();
    expect(other.root.children).toEqual([]);
  });
});
