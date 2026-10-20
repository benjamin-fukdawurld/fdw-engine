import {
  instantiate,
  ModelType,
  sharedSampler,
  TextureType,
} from '@fdw/engine-assets';
import {
  Camera,
  DirectionalLight,
  Material,
  PointLight,
  type Mesh,
} from '@fdw/engine-core';
import { Scene, SceneLods } from '@fdw/engine-scene';
import { describe, expect, it } from 'vitest';
import { captureScene } from './capture';
import { lodCodec, sceneCodecs } from './codecs';
import type { SceneData } from './data';
import { instantiateScene } from './instantiate';
import { testStore, tintedGraph, triangle } from './testing';

const tree = JSON.stringify({
  name: 'tree',
  nodes: [
    { name: 'trunk', children: [1, 2], mesh: 0, translation: [0, 1, 0] },
    { name: 'leaves', mesh: 1, translation: [0, 2, 0] },
    { name: 'leaves', mesh: 1, translation: [0, 3, 0] },
  ],
  roots: [0],
  meshes: [
    { color: [0.4, 0.3, 0.2, 1] },
    { color: [0, 1, 0, 1], primitives: 2 },
  ],
});

async function setup() {
  const { store, backend, warnings } = testStore({
    'tree.model': tree,
    'red.img': 'img 1 1 255 0 0 255',
  });
  const scene = new Scene();
  const texture = await store.load(TextureType, 'red.img').ready;
  const material = new Material({
    graph: tintedGraph(),
    values: {
      tint: [1, 0.5, 0.25],
      color: texture.texture,
      colorSampler: sharedSampler(backend, {
        wrapModeS: 'clamp-to-edge',
        minFilter: 'nearest',
      }),
    },
    label: 'tinted',
  });
  return { store, backend, scene, material, warnings };
}

const capture = (scene: Scene, store: ReturnType<typeof testStore>['store']) =>
  captureScene(scene, { store, warn: () => undefined });

describe('captureScene', () => {
  it('writes nodes, their fields, and the meshes and materials made in code', async () => {
    const { store, scene, material } = await setup();
    const mesh = triangle('made');
    const a = scene.root.add({
      name: 'a',
      position: { x: 1, y: 2, z: 3 },
      static: true,
    });
    a.add({ name: 'b', visible: false, layers: 2 }).setMesh(mesh, material, {
      castShadow: false,
    });
    a.add({ name: 'c' }).setMesh(mesh, material);
    const data = capture(scene, store);
    expect(data.nodes.map((n) => [n.name, n.parent])).toEqual([
      ['a', undefined],
      ['b', 0],
      ['c', 0],
    ]);
    expect(data.nodes[0]).toMatchObject({ position: [1, 2, 3], static: true });
    expect(data.nodes[0].rotation).toBeUndefined();
    expect(data.nodes[1]).toMatchObject({ visible: false, layers: 2 });
    expect(data.nodes[1].components?.['mesh renderer']).toEqual({
      version: 1,
      data: { mesh: '#mesh/0', material: '#material/0', castShadow: false },
    });
    // Written once, shared.
    expect(data.meshes).toHaveLength(1);
    expect(data.meshes[0].vertices).toBe(mesh.vertices);
    expect(data.materials).toHaveLength(1);
    expect(data.materials[0]).toMatchObject({
      kind: 'graph',
      name: 'tinted',
      values: {
        tint: [1, 0.5, 0.25],
        color: { texture: 'mem:red.img' },
        colorSampler: {
          sampler: { wrapModeS: 'clamp-to-edge', minFilter: 'nearest' },
        },
      },
    });
  });

  it('writes the URIs of the resources of the store, relative to the scene', async () => {
    const { store, scene } = await setup();
    const model = await store.load(ModelType, 'tree.model').ready;
    scene.root
      .add()
      .setMesh(model.meshes[0][0].mesh, model.meshes[0][0].material);
    const data = captureScene(scene, {
      store,
      uri: 'mem:levels/forest.scene.json',
    });
    expect(data.nodes[0].components?.['mesh renderer'].data).toEqual({
      mesh: '../tree.model#mesh/0/0',
      material: '../tree.model#material/0',
    });
  });

  it('writes leaf renderers alike as batches', async () => {
    const { store, scene, material } = await setup();
    const mesh = triangle();
    const group = scene.root.add({ name: 'forest' });
    const positions = Array.from({ length: 60 }, (_, i) => i);
    const entities = scene.createBatch({
      count: 20,
      parent: group.entity,
      positions,
      mesh,
      material,
      static: true,
      name: 'fir',
    });
    group.add({ name: 'alone' }).setMesh(mesh, material);
    const data = capture(scene, store);
    expect(data.nodes.map((n) => n.name)).toEqual(['forest', 'alone']);
    expect(data.batches).toHaveLength(1);
    const [batch] = data.batches;
    expect(batch).toMatchObject({
      parent: 0,
      name: 'fir',
      count: 20,
      static: true,
      mesh: '#mesh/0',
      material: '#material/0',
    });
    // Every transform, in the order of the siblings.
    const xs = [...entities].map((e) => positions[(e - entities[0]) * 3]);
    expect(
      Array.from({ length: 20 }, (_, i) => batch.positions[i * 3]).sort(
        (p, q) => p - q,
      ),
    ).toEqual(xs.sort((p, q) => p - q));
    expect(batch.scales[0]).toBe(1);
  });

  it('writes an instance of a model as its model and its changes', async () => {
    const { store, scene } = await setup();
    const model = store.load(ModelType, 'tree.model');
    await model.ready;
    const instance = instantiate(model, scene, {
      name: 'oak',
      position: { x: 5, y: 0, z: 0 },
    });
    model.release();
    const [trunk, leaves1, leaves2] = instance.nodes;
    // Moved, hidden, removed; a node added under a node of the model.
    trunk.transform.position = { x: 0, y: 1.5, z: 0 };
    leaves1.children[0].visible = false;
    scene.destroy(leaves2.entity);
    trunk.add({ name: 'nest', position: { x: 0, y: 0.5, z: 0 } });
    const data = capture(scene, store);
    expect(data.nodes).toEqual([
      {
        name: 'oak',
        position: [5, 0, 0],
        instance: {
          model: 'mem:tree.model',
          overrides: [
            { path: 'trunk', position: [0, 1.5, 0] },
            { path: 'trunk/#0/leaves#0', visible: false },
            { path: 'trunk/#1', removed: true },
          ],
        },
      },
      { name: 'nest', position: [0, 0.5, 0], parent: 0, parentPath: 'trunk' },
    ]);
  });
});

type Setup = Awaited<ReturnType<typeof setup>>;

describe('instantiateScene', () => {
  // Captures, instantiates in another scene, captures again: the same data.
  async function roundTrip(
    build: (scene: Scene, context: Setup) => void,
    codecs = sceneCodecs,
  ): Promise<{ first: SceneData; second: SceneData; scene: Scene }> {
    const context = await setup();
    const { store, scene } = context;
    build(scene, context);
    const first = captureScene(scene, { store, codecs });
    const other = new Scene();
    const instance = await instantiateScene(first, other, {
      store,
      codecs,
    });
    const second = captureScene(other, {
      store,
      codecs,
      root: instance.root,
    });
    return { first, second, scene: other };
  }

  it('makes the nodes of a scene again, with their meshes and materials', async () => {
    const { first, second, scene } = await roundTrip((scene, { material }) => {
      const mesh = triangle('made');
      const a = scene.root.add({
        name: 'a',
        position: { x: 1, y: 2, z: 3 },
        rotation: { x: 0, y: 0.6, z: 0, w: 0.8 },
        scale: { x: 2, y: 2, z: 2 },
        occluder: true,
      });
      a.add({ name: 'b', visible: false, layers: 2 }).setMesh(mesh, material, {
        castShadow: false,
      });
      a.add({ name: 'c' }).setMesh(mesh, material);
    });
    expect(second.nodes).toEqual(first.nodes);
    expect(second.materials).toEqual(
      first.materials.map((m) => ({ ...m, name: m.name })),
    );
    const b = scene.find('b')!;
    const mesh = scene.MeshRenderer.mesh[b.entity] as Mesh;
    expect(mesh.description.vertexCount).toBe(3);
    const material = scene.MeshRenderer.material[b.entity] as Material;
    expect(material.getValue('tint')).toEqual([1, 0.5, 0.25]);
    expect(material.getValue('colorSampler')).toMatchObject({
      wrapModeS: 'clamp-to-edge',
    });
  });

  it('makes the lights and cameras again', async () => {
    const { first, second, scene } = await roundTrip((scene) => {
      scene.root.add({ name: 'sun' }).setLight(
        new DirectionalLight({
          diffuse: { x: 2, y: 1.8, z: 1.5 },
          castShadow: true,
          shadow: { cascades: { count: 3, distance: 80 } },
        }),
      );
      scene.root
        .add({ name: 'lamp' })
        .setLight(new PointLight({ quadraticAttenuation: 1 }));
      scene.root.add({ name: 'eye' }).setCamera(
        new Camera({
          projection: {
            type: 'perspective',
            fov: 50,
            aspect: 2,
            near: 0.5,
            far: 90,
          },
        }),
      );
    });
    expect(second.nodes).toEqual(first.nodes);
    const sun = scene.Light.light[
      scene.find('sun')!.entity
    ] as DirectionalLight;
    expect(sun.castShadow).toBe(true);
    expect(sun.shadow.cascades?.count).toBe(3);
    expect(sun.diffuse.y).toBeCloseTo(1.8);
  });

  it('makes the batches again, and the levels of detail by their renderers', async () => {
    const context = await setup();
    const { store, scene, material } = context;
    const near = triangle('near');
    const far = triangle('far');
    const lods = new SceneLods(scene);
    const fine = scene.createBatch({
      count: 20,
      mesh: near,
      material,
      positions: Array(60).fill(1),
    });
    const coarse = scene.createBatch({ count: 20, mesh: far, material });
    fine.forEach((e, i) =>
      lods.add(e, [
        { nodes: [e], maxDistance: 10 },
        { nodes: [coarse[i]], maxDistance: 100 },
      ]),
    );
    const codecs = [...sceneCodecs, lodCodec(lods)];
    const first = captureScene(scene, { store, codecs });
    expect(first.nodes).toEqual([]);
    expect(first.batches.map((b) => b.count)).toEqual([20, 20]);
    const fineBatch = first.batches.find((b) => b.components)!;
    expect(fineBatch.components?.['lod'].data[0]).toMatchObject({
      levels: [{ maxDistance: 10 }, { maxDistance: 100 }],
    });
    const other = new Scene();
    const otherLods = new SceneLods(other);
    const otherCodecs = [...sceneCodecs, lodCodec(otherLods)];
    const instance = await instantiateScene(first, other, {
      store,
      codecs: otherCodecs,
    });
    expect(otherLods.Lod.count).toBe(20);
    const second = captureScene(other, {
      store,
      codecs: otherCodecs,
      root: instance.root,
    });
    expect(second.batches.map((b) => b.components)).toEqual(
      first.batches.map((b) => b.components),
    );
  });

  it('keeps the components of persisting numbers, and those without codec', async () => {
    const { store, scene } = await setup();
    const Health = scene.world.defineComponent(
      'health',
      { value: 'f32', color: ['f32', 3] },
      { persist: true, version: 2 },
    );
    const node = scene.root.add({ name: 'hero' });
    node.attach(Health, { value: 42, color: [1, 0, 0] });
    const data = captureScene(scene, { store });
    expect(data.nodes[0].components).toEqual({
      health: { version: 2, data: { value: 42, color: [1, 0, 0] } },
    });
    // A scene without the component: kept, and written again.
    const bare = new Scene();
    const warnings: string[] = [];
    const instance = await instantiateScene(data, bare, {
      store,
      warn: (m) => void warnings.push(m),
    });
    expect(
      captureScene(bare, { store, root: instance.root }).nodes[0].components,
    ).toEqual(data.nodes[0].components);
    // With it: read.
    const full = new Scene();
    const Again = full.world.defineComponent(
      'health',
      { value: 'f32', color: ['f32', 3] },
      { persist: true, version: 2 },
    );
    const back = await instantiateScene(data, full, { store });
    expect(Again.value[back.entities[0]]).toBe(42);
  });

  it('makes an instance of a model again, with its changes', async () => {
    const { store, scene } = await setup();
    const model = await store.load(ModelType, 'tree.model').ready;
    const instance = instantiate(model, scene, { name: 'oak' });
    const [trunk, leaves1, leaves2] = instance.nodes;
    trunk.transform.position = { x: 0, y: 1.5, z: 0 };
    leaves1.children[0].visible = false;
    scene.destroy(leaves2.entity);
    trunk.add({ name: 'nest', position: { x: 0, y: 0.5, z: 0 } });
    const first = capture(scene, store);
    const other = new Scene();
    const back = await instantiateScene(first, other, { store });
    expect(
      captureScene(other, { store, root: back.root, warn: () => undefined }),
    ).toEqual(first);
    const oak = other.find('oak')!;
    expect(oak.children[0].children.map((c) => c.name).sort()).toEqual([
      'leaves',
      'nest',
    ]);
  });
});
