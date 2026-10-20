import { DirectionalLight, Material } from '@fdw/engine-core';
import { Scene } from '@fdw/engine-scene';
import { describe, expect, it } from 'vitest';
import { captureScene } from './capture';
import { SceneDataType } from './data';
import { writeFdwScene } from './format';
import { installSceneIo } from './install';
import { instantiateScene } from './instantiate';
import { sceneInstanceOf } from './members';
import { testStore, tintedGraph, triangle } from './testing';

// A lamp made once, written as a scene, placed twice in a room.
async function setup() {
  const context = testStore({ 'red.img': 'img 1 1 255 0 0 255' });
  const { store, mem } = context;
  installSceneIo(store);
  const lamp = new Scene();
  const material = new Material({ graph: tintedGraph(), label: 'brass' });
  const post = lamp.root.add({ name: 'post' });
  post.setMesh(triangle('post', 2), material);
  post
    .add({ name: 'bulb', position: { x: 0, y: 2, z: 0 } })
    .setLight(new DirectionalLight({ diffuse: { x: 1, y: 0.9, z: 0.7 } }));
  const data = captureScene(lamp, {
    store,
    uri: 'mem:props/lamp.scene.json',
    name: 'lamp',
  });
  for (const file of await writeFdwScene(data, 'props/lamp.scene.json'))
    mem.set(file.path, file.bytes);
  return context;
}

describe('instances of scenes', () => {
  it('places a scene in another, and writes it as a reference with its changes', async () => {
    const { store } = await setup();
    const room = new Scene();
    const handle = store.load(SceneDataType, 'props/lamp.scene.json');
    const left = await instantiateScene(handle, room, {
      store,
      name: 'left lamp',
    });
    const right = await instantiateScene(handle, room, {
      store,
      name: 'right lamp',
    });
    handle.release();
    left.root.transform.position = { x: -2, y: 0, z: 0 };
    right.root.transform.position = { x: 2, y: 0, z: 0 };
    right.root.children[0].visible = false;
    expect(sceneInstanceOf(room, left.root.entity)?.nodes).toHaveLength(2);
    const data = captureScene(room, {
      store,
      uri: 'mem:levels/room.scene.json',
    });
    expect(data.nodes).toEqual([
      {
        name: 'left lamp',
        position: [-2, 0, 0],
        instance: { scene: '../props/lamp.scene.json' },
      },
      {
        name: 'right lamp',
        position: [2, 0, 0],
        instance: {
          scene: '../props/lamp.scene.json',
          overrides: [{ path: 'post', visible: false }],
        },
      },
    ]);
  });

  it('writes the instances made from a node of a scene, with their changes', async () => {
    const { store, mem } = await setup();
    // A room whose data places the lamp twice.
    const roomData = {
      name: 'room',
      nodes: [
        {
          name: 'left',
          position: [-2, 0, 0] as const,
          instance: { scene: '../props/lamp.scene.json' },
        },
        {
          name: 'right',
          position: [2, 0, 0] as const,
          instance: {
            scene: '../props/lamp.scene.json',
            overrides: [
              { path: 'post/bulb', position: [0, 3, 0] as const },
              { path: 'post', visible: false },
            ],
          },
        },
        { name: 'switch', parent: 1, parentPath: 'post' },
      ],
      batches: [],
      meshes: [],
      materials: [],
    };
    for (const file of await writeFdwScene(roomData, 'levels/room.scene.json'))
      mem.set(file.path, file.bytes);
    const room = new Scene();
    const handle = store.load(SceneDataType, 'levels/room.scene.json');
    const instance = await instantiateScene(handle, room, { store });
    handle.release();
    const right = room.find('right')!;
    const post = right.children.find((c) => c.name === 'post')!;
    expect(post.visible).toBe(false);
    expect(post.children.map((c) => c.name).sort()).toEqual(['bulb', 'switch']);
    expect(
      post.children.find((c) => c.name === 'bulb')!.transform.position.y,
    ).toBe(3);
    // Another change, then written back: the same data, and the new change.
    const left = room.find('left')!;
    const leftBulb = left.children[0].children[0];
    (room.Light.light[leftBulb.entity] as DirectionalLight).diffuse = {
      x: 0,
      y: 0,
      z: 1,
    };
    room.notify(leftBulb.entity, 'modified');
    left.children[0].remove();
    const data = captureScene(room, {
      store,
      uri: 'mem:levels/room.scene.json',
      root: instance.root,
      warn: (m) => {
        throw new Error(m);
      },
    });
    expect(data.nodes).toEqual([
      {
        name: 'left',
        position: [-2, 0, 0],
        instance: {
          scene: '../props/lamp.scene.json',
          overrides: [{ path: 'post', removed: true }],
        },
      },
      {
        name: 'right',
        position: [2, 0, 0],
        instance: {
          scene: '../props/lamp.scene.json',
          overrides: [
            { path: 'post', visible: false },
            { path: 'post/bulb', position: [0, 3, 0] },
          ],
        },
      },
      { name: 'switch', parent: 1, parentPath: 'post' },
    ]);
    instance.dispose();
    expect(room.root.children).toEqual([]);
  });

  it('writes a changed component of a node of an instance', async () => {
    const { store } = await setup();
    const room = new Scene();
    const handle = store.load(SceneDataType, 'props/lamp.scene.json');
    const roomRoot = room.root.add({ name: 'room' });
    const data = {
      nodes: [
        { name: 'lamp', instance: { scene: 'mem:props/lamp.scene.json' } },
      ],
      batches: [],
      meshes: [],
      materials: [],
    };
    const instance = await instantiateScene(data, room, {
      store,
      parent: roomRoot,
    });
    handle.release();
    const bulb = room.find('bulb')!;
    bulb.setLight(new DirectionalLight({ diffuse: { x: 0, y: 0, z: 1 } }));
    const captured = captureScene(room, { store, root: instance.root });
    const overrides = captured.nodes[0].instance!.overrides!;
    expect(overrides).toHaveLength(1);
    expect(overrides[0].path).toBe('post/bulb');
    expect(overrides[0].components!['light'].data).toMatchObject({
      diffuse: [0, 0, 1],
    });
  });
});
