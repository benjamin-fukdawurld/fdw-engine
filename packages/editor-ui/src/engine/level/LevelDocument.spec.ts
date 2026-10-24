import { installAssets } from '@fdw/engine-assets';
import { fakeBackend } from '@fdw/engine-core/testing';
import { installGltf, installGltfScenes } from '@fdw/engine-gltf';
import { MemorySource, ResourceStore } from '@fdw/engine-resources';
import { installSceneIo } from '@fdw/engine-scene-io';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineMessage, LevelNode, LevelProperties } from '../../protocol';
import { eulerFromQuat, quatFromEuler } from './euler';
import { LevelDocument, type LevelFiles } from './LevelDocument';

function files(): LevelFiles {
  const store = new ResourceStore();
  installAssets(store, { backend: fakeBackend().backend });
  installGltf(store);
  installGltfScenes(store);
  installSceneIo(store);
  const source = new MemorySource();
  store.mount('level', source);
  return { store, source, scheme: 'level' };
}

const documents: LevelDocument[] = [];

/**
 * A level and the page it talks to: the projection rebuilt from its
 * messages, as the store of the page does.
 */
function connect(document: LevelDocument) {
  documents.push(document);
  const page = {
    messages: [] as EngineMessage[],
    name: '',
    root: '',
    dirty: false,
    nodes: new Map<string, LevelNode>(),
    selection: [] as readonly string[],
    properties: undefined as LevelProperties | undefined,
    undo: undefined as string | undefined,
    redo: undefined as string | undefined,
  };
  document.connect((message) => {
    page.messages.push(message);
    switch (message.type) {
      case 'level':
        Object.assign(page, message);
        break;
      case 'level.nodes':
        if (message.reset) page.nodes.clear();
        for (const id of message.removed) page.nodes.delete(id);
        for (const node of message.nodes) page.nodes.set(node.id, node);
        break;
      case 'level.selection':
        page.selection = message.ids;
        break;
      case 'level.properties':
        page.properties = message.properties;
        break;
      case 'level.history':
        page.undo = message.undo;
        page.redo = message.redo;
        break;
    }
  });
  const named = (name: string) =>
    [...page.nodes.values()].find((node) => node.name === name);
  const names = (id = page.root) =>
    (page.nodes.get(id)?.children ?? []).map(
      (child) => page.nodes.get(child)?.name,
    );
  return { page, named, names };
}

// The changes of the scene come in a batch, after the code.
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

const sample = [
  'ground',
  'cube 1',
  'cube 2',
  'cube 3',
  'sphere 1',
  'sphere 2',
  'table',
  'sun',
];

afterEach(() => {
  documents.splice(0).forEach((document) => document.dispose());
});

describe('LevelDocument', () => {
  it('tells the page the whole level when connected', () => {
    const document = LevelDocument.create(files());
    const { page, names, named } = connect(document);
    expect(page.name).toBe('level.scene.json');
    expect(page.dirty).toBe(false);
    expect(names()).toEqual(sample);
    expect(names(named('table')?.id)).toEqual([
      'top',
      'leg 1',
      'leg 2',
      'leg 3',
      'leg 4',
    ]);
    expect(named('cube 1')?.kind).toBe('mesh');
    expect(named('sun')?.kind).toBe('light');
    expect(named('table')?.kind).toBe('node');
    expect(page.selection).toEqual([]);
    expect(page.properties).toBeUndefined();
    expect(page.undo).toBeUndefined();
  });

  it('selects by ids, and tells the properties of the active node', () => {
    const document = LevelDocument.create(files());
    const { page, named } = connect(document);
    const cube = named('cube 1')?.id ?? '';
    const sphere = named('sphere 1')?.id ?? '';
    document.run({ command: 'select', ids: [cube, sphere, 'gone:0'] });
    expect(page.selection).toEqual([cube, sphere]);
    expect(page.properties).toMatchObject({
      id: sphere,
      name: 'sphere 1',
      visible: true,
      position: [0.4, 0.6, 1.6],
      rotation: [0, 0, 0],
      scale: [1.2, 1.2, 1.2],
      components: [{ name: 'Mesh renderer' }],
    });
    // Not in the history.
    expect(page.undo).toBeUndefined();
  });

  it('edits the transform by commands, undone and redone', async () => {
    const document = LevelDocument.create(files());
    const { page, named } = connect(document);
    const cube = named('cube 1')?.id ?? '';
    document.run({ command: 'select', ids: [cube] });
    document.run({
      command: 'edit',
      id: cube,
      property: 'position',
      value: [1, 2, 3],
    });
    // The steps of a field make one entry.
    document.run({
      command: 'edit',
      id: cube,
      property: 'rotation',
      value: [0, 45, 0],
    });
    document.run({
      command: 'edit',
      id: cube,
      property: 'rotation',
      value: [0, 90, 0],
    });
    await settled();
    expect(page.properties?.position).toEqual([1, 2, 3]);
    expect(page.properties?.rotation).toEqual([0, 90, 0]);
    expect(page.undo).toBe('Rotate cube 1');
    expect(page.dirty).toBe(true);
    document.run({ command: 'undo' });
    await settled();
    expect(page.properties?.rotation).toEqual([0, 0, 0]);
    expect(page.redo).toBe('Rotate cube 1');
    document.run({ command: 'undo' });
    await settled();
    expect(page.properties?.position).toEqual([-3, 0.5, 1]);
    document.run({ command: 'redo' });
    await settled();
    expect(page.properties?.position).toEqual([1, 2, 3]);
  });

  it('renames and hides nodes: the tree follows', async () => {
    const document = LevelDocument.create(files());
    const { page, named } = connect(document);
    const cube = named('cube 2')?.id ?? '';
    document.run({ command: 'edit', id: cube, property: 'name', value: 'box' });
    document.run({
      command: 'edit',
      id: cube,
      property: 'visible',
      value: false,
    });
    await settled();
    expect(page.nodes.get(cube)).toMatchObject({ name: 'box', visible: false });
    document.run({ command: 'undo' });
    document.run({ command: 'undo' });
    await settled();
    expect(page.nodes.get(cube)).toMatchObject({
      name: 'cube 2',
      visible: true,
    });
  });

  it('adds and deletes nodes; undone, the same ones come back', async () => {
    const document = LevelDocument.create(files());
    const { page, names, named } = connect(document);
    document.run({ command: 'add', primitive: 'sphere' });
    await settled();
    const added = named('sphere')?.id ?? '';
    expect(names()).toEqual([...sample, 'sphere']);
    expect(page.selection).toEqual([added]);
    expect(page.properties?.position).toEqual([0, 0.5, 0]);
    expect(page.undo).toBe('Add sphere');

    const table = named('table')?.id ?? '';
    document.run({ command: 'select', ids: [table, added] });
    document.run({ command: 'delete' });
    await settled();
    expect(names()).toEqual(sample.filter((name) => name !== 'table'));
    expect(page.nodes.has(table)).toBe(false);
    expect(named('leg 1')).toBeUndefined();
    expect(page.selection).toEqual([]);
    expect(page.undo).toBe('Delete 2 nodes');

    document.run({ command: 'undo' });
    await settled();
    // Back from the trash as the last child (P15).
    expect(names()).toEqual([
      ...sample.filter((name) => name !== 'table'),
      'table',
      'sphere',
    ]);
    expect(named('table')?.id).toBe(table);
    expect(named('leg 1')).toBeDefined();
    document.run({ command: 'undo' });
    await settled();
    expect(names()).not.toContain('sphere');
  });

  it('moves a node under another, not under itself', async () => {
    const document = LevelDocument.create(files());
    const { page, names, named } = connect(document);
    const cube = named('cube 3')?.id ?? '';
    const table = named('table')?.id ?? '';
    document.run({ command: 'reparent', id: cube, parent: table });
    await settled();
    expect(names()).not.toContain('cube 3');
    expect(names(table).at(-1)).toBe('cube 3');
    expect(page.undo).toBe('Move cube 3 to table');
    document.run({ command: 'reparent', id: table, parent: cube });
    expect(page.undo).toBe('Move cube 3 to table');
    document.run({ command: 'undo' });
    await settled();
    expect(names()).toContain('cube 3');
    expect(names(table)).not.toContain('cube 3');
  });

  it('edits the numbers of a component saved field by field', async () => {
    const document = LevelDocument.create(files());
    const Spin = document.scene.world.defineComponent(
      'spin',
      { speed: 'f32' },
      { persist: true },
    );
    const node = document.scene.find('cube 1');
    node?.attach(Spin, { speed: 0.5 });
    const { page, named } = connect(document);
    const cube = named('cube 1')?.id ?? '';
    document.run({ command: 'select', ids: [cube] });
    expect(page.properties?.components).toEqual([
      { name: 'Mesh renderer' },
      { name: 'spin', fields: [{ name: 'speed', value: 0.5 }] },
    ]);
    document.run({
      command: 'edit',
      id: cube,
      property: 'field',
      component: 'spin',
      field: 'speed',
      value: 2,
    });
    await settled();
    expect(Spin.speed[node?.entity ?? 0]).toBe(2);
    expect(page.properties?.components[1]).toEqual({
      name: 'spin',
      fields: [{ name: 'speed', value: 2 }],
    });
    expect(page.undo).toBe('Set spin speed');
  });

  it('saves a scene of the engine in one file, and opens it again', async () => {
    const levelFiles = files();
    const document = LevelDocument.create(levelFiles);
    const { page, named } = connect(document);
    const cube = named('cube 1')?.id ?? '';
    document.run({
      command: 'edit',
      id: cube,
      property: 'position',
      value: [1, 2, 3],
    });
    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);
    const data = await document.save('fdw-scene', 'mine.scene.json', warn);
    const json = JSON.parse(new TextDecoder().decode(data));
    expect(json.format).toBe('fdw-scene');
    expect(page.dirty).toBe(true);
    document.saved('mine.scene.json');
    expect(page).toMatchObject({ name: 'mine.scene.json', dirty: false });

    const opened = await LevelDocument.open(
      levelFiles,
      'mine.scene.json',
      data,
      warn,
    );
    const reopened = connect(opened);
    expect(reopened.names()).toEqual(sample);
    expect(reopened.page.dirty).toBe(false);
    const moved = reopened.named('cube 1')?.id ?? '';
    opened.run({ command: 'select', ids: [moved] });
    expect(reopened.page.properties?.position).toEqual([1, 2, 3]);
    expect(reopened.named('sun')?.kind).toBe('light');
    expect(warnings).toEqual([]);
  });

  it('exports glTF, read back as a level', async () => {
    const levelFiles = files();
    const document = LevelDocument.create(levelFiles);
    connect(document);
    const warn = () => undefined;
    const data = await document.save('glb', 'level.glb', warn);
    expect(new TextDecoder().decode(data.subarray(0, 4))).toBe('glTF');
    const opened = await LevelDocument.open(
      levelFiles,
      'level.glb',
      data,
      warn,
    );
    const { names } = connect(opened);
    expect(names()).toEqual(expect.arrayContaining(['cube 1', 'table', 'sun']));
  });
});

describe('the rotations of the inspector', () => {
  it('go from Euler angles to quaternions and back', () => {
    for (const angles of [
      [0, 0, 0],
      [30, 45, 60],
      [-120, 10, 170],
      [10, -80, -35],
    ] as [number, number, number][]) {
      const back = eulerFromQuat(quatFromEuler(angles));
      back.forEach((angle, i) => expect(angle).toBeCloseTo(angles[i], 4));
    }
    // A quarter turn around Y.
    const [x, y, z, w] = quatFromEuler([0, 90, 0]);
    expect([x, y, z, w].map((v) => +v.toFixed(5))).toEqual([
      0,
      +Math.SQRT1_2.toFixed(5),
      0,
      +Math.SQRT1_2.toFixed(5),
    ]);
  });
});
