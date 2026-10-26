import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EditorShell } from '../EditorShell';
import type { EngineMessage, LevelNode, PageMessage } from '../protocol';
import type { EditorRuntime } from '../state/runtime';
import { fakeHost, readyMessage, stubLayout } from '../testing';
import { levelFileName, viewportTool } from './level';

beforeAll(stubLayout);
afterEach(cleanup);

const node = (
  id: string,
  name: string,
  children: string[] = [],
  kind: LevelNode['kind'] = 'mesh',
): LevelNode => ({ id, name, kind, visible: true, children });

// The level as the engine tells it: a root, a cube, a group with a leg.
const level: EngineMessage[] = [
  { type: 'level', name: 'level.scene.json', root: '0:0', dirty: false },
  {
    type: 'level.nodes',
    reset: true,
    removed: [],
    nodes: [
      node('0:0', 'root', ['1:0', '2:0'], 'node'),
      node('1:0', 'cube 1'),
      node('2:0', 'table', ['3:0'], 'node'),
      node('3:0', 'leg 1'),
    ],
  },
];

async function renderLevel() {
  const fake = fakeHost();
  let runtime: EditorRuntime | undefined;
  render(
    <EditorShell host={fake.host} onRuntime={(made) => (runtime = made)} />,
    {
      wrapper: StrictMode,
    },
  );
  await screen.findByTestId('viewport');
  const send = (message: EngineMessage) => act(() => fake.send(message));
  send(readyMessage);
  level.forEach(send);
  if (!runtime) throw new Error('No runtime');
  const sent = <T extends PageMessage['type']>(type: T) =>
    fake.posted.filter(
      (message): message is Extract<PageMessage, { type: T }> =>
        message.type === type,
    );
  return { ...fake, send, sent, runtime };
}

const rows = () =>
  within(screen.getByRole('tree', { name: 'Level' }))
    .queryAllByRole('treeitem')
    .map((row) => row.textContent);

function openMenu(name: string) {
  fireEvent.keyDown(screen.getByRole('menuitem', { name }), { key: 'Enter' });
  return screen.getByRole('menu');
}

describe('the level in the editor', () => {
  it('shows its tree, and selects from it', async () => {
    const { send, sent, runtime } = await renderLevel();
    expect(rows()).toEqual(['cube 1', 'table']);
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    expect(rows()).toEqual(['cube 1', 'table', 'leg 1']);

    fireEvent.click(screen.getByText('cube 1'));
    fireEvent.click(screen.getByText('leg 1'), { ctrlKey: true });
    expect(sent('level.command').slice(-2)).toEqual([
      { type: 'level.command', command: 'select', ids: ['1:0'] },
      { type: 'level.command', command: 'select', ids: ['3:0'] },
    ]);
    // The selection is the engine's: shown once it tells it.
    send({ type: 'level.selection', ids: ['1:0', '3:0'] });
    const selected = within(screen.getByRole('tree'))
      .getAllByRole('treeitem')
      .filter((row) => row.getAttribute('aria-selected') === 'true')
      .map((row) => row.textContent);
    expect(selected).toEqual(['cube 1', 'leg 1']);
    expect(runtime.editor.getSnapshot().context.selection).toEqual([
      '1:0',
      '3:0',
    ]);
    expect(runtime.keys.values()['scene.hasSelection']).toBe(true);

    // Renamed and removed: the tree follows.
    send({
      type: 'level.nodes',
      nodes: [node('0:0', 'root', ['2:0'], 'node')],
      removed: ['1:0'],
    });
    expect(rows()).toEqual(['table', 'leg 1']);

    fireEvent.click(screen.getByRole('button', { name: 'Hide table' }));
    expect(sent('level.command').at(-1)).toEqual({
      type: 'level.command',
      command: 'edit',
      id: '2:0',
      property: 'visible',
      value: false,
    });
  });

  it('shows the properties of the active node, and edits them', async () => {
    const { send, sent } = await renderLevel();
    expect(screen.getByText('Nothing selected.')).toBeTruthy();
    send({
      type: 'level.properties',
      properties: {
        id: '1:0',
        name: 'cube 1',
        visible: true,
        position: [1, 2, 3],
        rotation: [0, 90, 0],
        scale: [1, 1, 1],
        components: [
          { name: 'Mesh renderer' },
          { name: 'spin', fields: [{ name: 'speed', value: 0.5 }] },
        ],
      },
    });
    const y = screen.getByLabelText('Position Y') as HTMLInputElement;
    expect(y.value).toBe('2');
    expect(
      (screen.getByLabelText('Rotation Y') as HTMLInputElement).value,
    ).toBe('90');
    fireEvent.change(y, { target: { value: '5' } });
    fireEvent.keyDown(y, { key: 'Enter' });
    expect(sent('level.command').at(-1)).toEqual({
      type: 'level.command',
      command: 'edit',
      id: '1:0',
      property: 'position',
      value: [1, 5, 3],
    });
    const name = screen.getByLabelText('Name');
    fireEvent.change(name, { target: { value: 'box' } });
    fireEvent.blur(name);
    expect(sent('level.command').at(-1)).toMatchObject({
      property: 'name',
      value: 'box',
    });
    const speed = screen.getByLabelText('spin speed');
    fireEvent.change(speed, { target: { value: '2' } });
    fireEvent.keyDown(speed, { key: 'Enter' });
    expect(sent('level.command').at(-1)).toMatchObject({
      property: 'field',
      component: 'spin',
      field: 'speed',
      value: 2,
    });
  });

  it('opens a file of the host, and saves the level through it', async () => {
    const { host, send, sent, runtime } = await renderLevel();
    const data = new Uint8Array([1, 2, 3]);
    host.files.open = vi.fn(async () => ({ name: 'mine.glb', data }));
    const save = vi.fn(async () => true);
    host.files.save = save;

    await act(() => runtime.commands.execute('fdw.level.open'));
    expect(sent('level.open')).toEqual([
      { type: 'level.open', name: 'mine.glb', data },
    ]);
    expect(runtime.engine.getSnapshot().context.scene).toBe('level');

    // Saved: the engine writes the file, the host saves it.
    fireEvent.click(
      within(openMenu('File')).getByRole('menuitem', { name: 'Save level' }),
    );
    await waitFor(() => expect(sent('level.save')).toHaveLength(1));
    expect(sent('level.save')[0]).toEqual({
      type: 'level.save',
      format: 'fdw-scene',
      name: 'level.scene.json',
    });
    const file = new Uint8Array([4]);
    send({
      type: 'level.file',
      name: 'level.scene.json',
      format: 'fdw-scene',
      data: file,
    });
    await waitFor(() => expect(sent('level.saved')).toHaveLength(1));
    expect(save).toHaveBeenCalledWith(
      'level.scene.json',
      file,
      expect.anything(),
    );
  });

  it('routes the main button of the viewport by the tool of the primary slot', async () => {
    const { sent, runtime } = await renderLevel();
    await waitFor(() =>
      expect(sent('level.tool').at(-1)).toEqual({
        type: 'level.tool',
        tool: 'select',
      }),
    );
    act(() => {
      runtime.engine.trigger.chooseScene({ scene: 'level' });
    });
    fireEvent.keyDown(window, { key: 'w', code: 'KeyW' });
    await waitFor(() =>
      expect(sent('level.tool').at(-1)?.tool).toBe('translate'),
    );
    expect(screen.getByText('Object mode · Move')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'x', code: 'KeyX' });
    expect(sent('level.gizmo').at(-1)).toMatchObject({ space: 'local' });
    expect(runtime.keys.values()['level.gizmo.local']).toBe(true);
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(sent('level.tool').at(-1)?.tool).toBe('select'));
  });

  it('draws the level with rays where the engine traces them', async () => {
    const { send, sent, runtime } = await renderLevel();
    // An engine without rays: only the rasterized rendering.
    expect(runtime.keys.values()['engine.rays']).toBe(false);
    expect(runtime.commands.enabled('fdw.level.rendering.path')).toBe(false);
    send({ ...readyMessage, rays: true });
    expect(runtime.commands.enabled('fdw.level.rendering.path')).toBe(true);
    await act(() => runtime.commands.execute('fdw.level.rendering.path'));
    expect(sent('level.rendering').at(-1)?.rendering).toBe('path');
    expect(runtime.keys.values()['level.rendering']).toBe('path');
    // The gizmo keeps it; a new engine is told it again.
    fireEvent.keyDown(window, { key: 'x', code: 'KeyX' });
    expect(runtime.keys.values()['level.rendering']).toBe('path');
    send({ ...readyMessage, rays: true });
    expect(sent('level.rendering').at(-1)?.rendering).toBe('path');
  });

  it('draws the rectangle of a selection over the viewport', async () => {
    const { send } = await renderLevel();
    send({
      type: 'level.rectangle',
      rectangle: { x: 10, y: 20, width: 100, height: 50 },
    });
    const lines = screen.getAllByTestId('selection-rectangle');
    expect(lines).toHaveLength(4);
    expect(lines.every((line) => line.hasAttribute('data-over-viewport'))).toBe(
      true,
    );
    send({ type: 'level.rectangle' });
    expect(screen.queryAllByTestId('selection-rectangle')).toHaveLength(0);
  });
});

describe('the helpers of the level', () => {
  it('give the tool of the viewport and the names of the files', () => {
    expect(viewportTool(undefined)).toBe('select');
    expect(viewportTool('fdw.level.rotate')).toBe('rotate');
    expect(viewportTool('fdw.sample.mark')).toBe('none');
    expect(levelFileName('forest.scene.json', 'glb')).toBe('forest.glb');
    expect(levelFileName('mine.glb', 'fdw-scene')).toBe('mine.scene.json');
    expect(levelFileName('', 'fdw-scene')).toBe('level.scene.json');
  });
});
