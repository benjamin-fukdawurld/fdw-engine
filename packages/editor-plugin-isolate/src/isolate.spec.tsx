import {
  EditorShell,
  type EditorRuntime,
  type EngineMessage,
  type LevelNode,
  type LevelStoreContext,
} from '@fdw/editor-ui';
import { fakeHost, readyMessage, stubLayout } from '@fdw/editor-ui/testing';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  isolateCommand,
  isolatedKey,
  isolateId,
  isolatePlugin,
  showAllCommand,
} from './index';
import { levelStatistics, nodesToHide } from './main';

beforeAll(stubLayout);

const node = (
  id: string,
  kind: LevelNode['kind'],
  children: string[] = [],
  visible = true,
): LevelNode => ({ id, name: id, kind, visible, children });

// A root, two cubes, a lamp, and a table of two legs.
const nodes: LevelNode[] = [
  node('root', 'node', ['cube1', 'cube2', 'lamp', 'table']),
  node('cube1', 'mesh'),
  node('cube2', 'mesh'),
  node('lamp', 'light'),
  node('table', 'node', ['leg1', 'leg2']),
  node('leg1', 'mesh'),
  node('leg2', 'mesh', [], false),
];

const level = (selection: string[]): LevelStoreContext => ({
  name: 'test.scene.json',
  root: 'root',
  dirty: false,
  nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
  selection,
});

describe('the statistics and the nodes to hide', () => {
  it('counts the nodes by kind, without the root', () => {
    expect(levelStatistics(level(['cube1']))).toEqual({
      nodes: 6,
      kinds: { node: 1, mesh: 4, light: 1, camera: 0 },
      hidden: 1,
      selected: 1,
    });
  });

  it('counts as hidden the nodes under a parent hidden', () => {
    const tableHidden = level([]);
    const table = tableHidden.nodes['table'] as LevelNode;
    const nodes = { ...tableHidden.nodes, table: { ...table, visible: false } };
    expect(levelStatistics({ ...tableHidden, nodes }).hidden).toBe(3);
  });

  it('hides the nodes under the root that hold none of the selection', () => {
    expect(nodesToHide(level(['cube1']))).toEqual(['cube2', 'lamp', 'table']);
    // A leg selected keeps its table.
    expect(nodesToHide(level(['leg1', 'lamp']))).toEqual(['cube1', 'cube2']);
  });
});

describe('the isolate plugin', () => {
  afterEach(cleanup);

  async function renderLevel() {
    const fake = fakeHost({}, [isolatePlugin]);
    let runtime: EditorRuntime | undefined;
    render(
      <EditorShell host={fake.host} onRuntime={(made) => (runtime = made)} />,
      { wrapper: StrictMode },
    );
    await screen.findByTestId('viewport');
    if (!runtime) throw new Error('No runtime');
    const send = (message: EngineMessage) => act(() => fake.send(message));
    send({ ...readyMessage, scenes: ['level'], scene: 'level' });
    send({
      type: 'level',
      name: 'test.scene.json',
      root: 'root',
      dirty: false,
    });
    send({ type: 'level.nodes', reset: true, nodes, removed: [] });
    return { ...fake, runtime, send };
  }

  // The visibilities the page asked the engine for, by node.
  const edits = (posted: readonly unknown[]) =>
    posted.flatMap((message) => {
      const edit = message as {
        type: string;
        command?: string;
        id?: string;
        value?: unknown;
      };
      return edit.type === 'level.command' && edit.command === 'edit'
        ? [[edit.id, edit.value]]
        : [];
    });

  it('isolates the selection by its command, then shows everything', async () => {
    const { runtime, posted, send } = await renderLevel();
    // Loaded with its panel, open in the default layout.
    await waitFor(() =>
      expect(runtime.plugins.info(isolateId)?.status).toBe('active'),
    );
    // Disabled without a selection.
    expect(runtime.keys.matches(`scene.hasSelection && !${isolatedKey}`)).toBe(
      false,
    );
    send({ type: 'level.selection', ids: ['cube1'] });
    await act(() => runtime.commands.execute(isolateCommand));
    expect(edits(posted)).toEqual([
      ['cube2', false],
      ['lamp', false],
      ['table', false],
    ]);
    expect(runtime.keys.values()[isolatedKey]).toBe(true);

    posted.length = 0;
    await act(() => runtime.commands.execute(showAllCommand));
    expect(edits(posted)).toEqual([
      ['cube2', true],
      ['lamp', true],
      ['table', true],
    ]);
    expect(runtime.keys.values()[isolatedKey]).toBeUndefined();
  });

  it('isolates with its key over the level, and tells it in the status bar', async () => {
    const { runtime, send } = await renderLevel();
    send({ type: 'level.selection', ids: ['lamp'] });
    fireEvent.keyDown(window, { key: 'i' });
    await waitFor(() => expect(runtime.keys.values()[isolatedKey]).toBe(true));
    // The engine answers with the nodes hidden.
    send({
      type: 'level.nodes',
      reset: false,
      nodes: ['cube1', 'cube2', 'table'].map((id) => ({
        ...(nodes.find((n) => n.id === id) as LevelNode),
        visible: false,
      })),
      removed: [],
    });
    expect(
      await screen.findByText('Isolated: 1 of 6 nodes shown'),
    ).toBeTruthy();
    fireEvent.keyDown(window, { key: 'I', shiftKey: true });
    await waitFor(() =>
      expect(runtime.keys.values()[isolatedKey]).toBeUndefined(),
    );
    expect(screen.queryByText(/Isolated:/)).toBeNull();
  });

  it('shows the statistics in its panel', async () => {
    const { runtime, send } = await renderLevel();
    send({ type: 'level.selection', ids: ['cube1', 'cube2'] });
    await act(() => runtime.workbench.openView(`${isolateId}.statistics`));
    expect(await screen.findByText('6 nodes in the level.')).toBeTruthy();
    const selected = screen.getByText('Selected').nextElementSibling;
    expect(selected?.textContent).toBe('2');
    fireEvent.click(
      screen.getByRole('button', { name: 'Isolate the selection' }),
    );
    expect(
      await screen.findByRole('button', { name: 'Show everything' }),
    ).toBeTruthy();
  });
});
