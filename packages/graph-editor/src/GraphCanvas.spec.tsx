import {
  actionNode,
  BehaviorGraphBuilder,
  createBehaviorRegistry,
} from '@fdw/engine-behavior';
import {
  behaviorGraphKind,
  type CommandResult,
  type GraphCommand,
  GraphSession,
} from '@fdw/engine-graph-editing';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GraphCanvas, type GraphOverlay } from './GraphCanvas';
import { edgeKey } from './geometry';
import { searchItems } from './NodeSearch';
import { stubGraphDom } from './testing';

beforeAll(stubGraphDom);

const roar = actionNode({
  id: 'game.roar',
  category: 'game',
  run: () => undefined,
});
const registry = createBehaviorRegistry([roar]);
const kind = behaviorGraphKind(registry);

// A guard: its anger rises at each hit; past 50, it roars.
function guard() {
  const g = new BehaviorGraphBuilder('guard', registry);
  g.variable('anger', 'number');
  g.event('hit', { damage: 'number' });
  const hit = g.on('hit', { id: 'hit' });
  const angry = g.set(
    hit.then,
    'anger',
    g.add(g.get('anger'), hit.value('damage')),
    { id: 'angry' },
  );
  const check = g.branch(angry.then, g.compare(angry.value(), '>', 50), {
    id: 'check',
  });
  g.node('game.roar', { from: check.exec('true') }, { id: 'roar' });
  return g.build();
}

// The canvas on a session of the page: each command done at once.
function renderCanvas(overlay?: GraphOverlay) {
  const session = new GraphSession('s', kind, guard());
  const results: CommandResult[] = [];
  let setView: (revision: number) => void = () => undefined;
  function Harness() {
    const [, rerender] = useState(0);
    setView = rerender;
    const [selection, setSelection] = useState<readonly string[]>([]);
    return (
      <GraphCanvas
        view={session.projection()}
        templates={session.templates()}
        accepts={kind.accepts}
        dispatch={(command: GraphCommand) => {
          results.push(session.execute(command));
        }}
        selection={selection}
        onSelectionChange={setSelection}
        {...(overlay && { overlay })}
      />
    );
  }
  session.subscribe(() => act(() => setView(session.revision)));
  render(<Harness />);
  const canvas = screen.getByRole('application');
  const node = (title: string) => screen.getByRole('group', { name: title });
  const port = (title: string, side: 'input' | 'output', name: string) =>
    screen.getByLabelText(`${title} ${side} ${name}`);
  return { session, results, canvas, node, port };
}

const press = (target: Element, init: Record<string, unknown> = {}) =>
  fireEvent.pointerDown(target, { button: 0, clientX: 0, clientY: 0, ...init });
const release = (
  target: Element | Window,
  init: Record<string, unknown> = {},
) => fireEvent.pointerUp(target, { button: 0, ...init });

describe('GraphCanvas', () => {
  afterEach(cleanup);

  it('draws the nodes, their ports and the wires', () => {
    const { canvas, node, port } = renderCanvas();
    expect(node('On hit')).toBeTruthy();
    expect(node('Set anger')).toBeTruthy();
    expect(port('On hit', 'output', 'damage').dataset['fits']).toBeUndefined();
    expect(canvas.querySelectorAll('[data-edge]')).toHaveLength(
      guard().edges.length,
    );
  });

  it('selects, moves and deletes nodes, undone by Ctrl+Z', () => {
    const { session, canvas, node } = renderCanvas();
    const before = session.projection().layout.nodes?.['roar'];
    press(node('roar'), { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 60, clientY: 30 });
    release(window, { clientX: 60, clientY: 30 });
    expect(session.projection().layout.nodes?.['roar']).toEqual({
      x: (before?.x ?? 0) + 50,
      y: (before?.y ?? 0) + 20,
    });
    expect(node('roar').className).toContain('ring-sky-400');
    // Shift adds to the selection; Delete removes both.
    press(node('On hit'), { shiftKey: true });
    release(window);
    fireEvent.keyDown(canvas, { key: 'Delete' });
    expect(session.projection().nodes.map((n) => n.id)).not.toContain('roar');
    expect(session.projection().nodes.map((n) => n.id)).not.toContain('hit');
    fireEvent.keyDown(canvas, { key: 'z', ctrlKey: true });
    expect(session.projection().nodes.map((n) => n.id)).toContain('roar');
  });

  it('connects a wire dragged from an output to an input, and tells the ports that fit', () => {
    const { session, results, port } = renderCanvas();
    press(port('compare >', 'output', 'value'));
    fireEvent.pointerMove(window, { clientX: 5, clientY: 5 });
    // A boolean fits the condition, not a number.
    expect(port('branch', 'input', 'condition').dataset['fits']).toBe('true');
    expect(port('add', 'input', 'a').dataset['fits']).toBeUndefined();
    release(port('roar', 'input', 'exec'));
    // The flow into a value, refused by the session.
    expect(results.at(-1)?.refused).toBe('A value goes into a value input');
    press(port('On hit', 'output', 'then'));
    release(port('roar', 'input', 'exec'));
    expect(session.projection().edges).toContainEqual({
      from: { node: 'hit', port: 'then' },
      to: { node: 'roar', port: 'exec' },
    });
    // Alt+click on a port disconnects it.
    press(port('roar', 'input', 'exec'), { altKey: true });
    expect(
      session.projection().edges.filter((e) => e.to.node === 'roar'),
    ).toEqual([]);
  });

  it('searches a node for a wire dropped in the void, and connects it', () => {
    const { session, port } = renderCanvas();
    press(port('On hit', 'output', 'damage'));
    fireEvent.pointerMove(window, { clientX: 300, clientY: 300 });
    release(window, { clientX: 300, clientY: 300 });
    const search = screen.getByRole('dialog', { name: 'Add a node' });
    const options = () =>
      Array.from(search.querySelectorAll('[role="option"]')).map(
        (option) => option.firstElementChild?.firstElementChild?.textContent,
      );
    // Only the nodes that take a number.
    expect(options()).toContain('Set anger');
    expect(options()).not.toContain('On hit');
    fireEvent.change(screen.getByRole('textbox', { name: 'Add a node' }), {
      target: { value: 'set ang' },
    });
    expect(options()[0]).toBe('Set anger');
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Add a node' }), {
      key: 'Enter',
    });
    const added = session.projection().nodes.at(-1);
    expect(added?.title).toBe('Set anger');
    expect(session.projection().edges.at(-1)).toEqual({
      from: { node: 'hit', port: 'damage' },
      to: { node: added?.id, port: 'value' },
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('copies, pastes, duplicates, groups and lays notes by the keys', () => {
    const { session, canvas, node } = renderCanvas();
    const count = session.projection().nodes.length;
    press(node('branch'));
    release(window);
    press(node('roar'), { shiftKey: true });
    release(window);
    fireEvent.keyDown(canvas, { key: 'c', ctrlKey: true });
    fireEvent.keyDown(canvas, { key: 'v', ctrlKey: true });
    let view = session.projection();
    expect(view.nodes).toHaveLength(count + 2);
    // The edge between the copies came with them.
    const [branch, copy] = view.nodes.slice(-2).map((n) => n.id);
    expect(view.edges).toContainEqual({
      from: { node: branch, port: 'true' },
      to: { node: copy, port: 'exec' },
    });
    fireEvent.keyDown(canvas, { key: 'd', ctrlKey: true });
    expect(session.projection().nodes).toHaveLength(count + 4);
    fireEvent.keyDown(canvas, { key: 'g', ctrlKey: true });
    view = session.projection();
    expect(view.layout.groups).toEqual([
      { id: 'group1', title: 'Group', nodes: ['check', 'roar'] },
    ]);
    fireEvent.keyDown(canvas, { key: 'n' });
    expect(session.projection().layout.notes?.[0]).toMatchObject({
      id: 'note1',
      text: 'A note',
    });
    // Written at once.
    fireEvent.blur(screen.getByLabelText('Note'), {
      target: { value: 'Rises with the hits' },
    });
    expect(session.projection().layout.notes?.[0].text).toBe(
      'Rises with the hits',
    );
    // Space opens the search, Escape closes it.
    fireEvent.keyDown(canvas, { key: ' ' });
    const field = screen.getByRole('textbox', { name: 'Add a node' });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the state of the running graph', () => {
    const { canvas, node } = renderCanvas({
      nodes: {
        check: { marker: 'paused', badge: '3×', values: { false: 'x' } },
        roar: { marker: 'breakpoint', weight: 0.5 },
      },
      edges: new Set([
        edgeKey({
          from: { node: 'hit', port: 'then' },
          to: { node: 'angry', port: 'exec' },
        }),
      ]),
    });
    expect(node('branch').className).toContain('ring-amber-400');
    expect(screen.getByText('3×')).toBeTruthy();
    expect(screen.getByLabelText('Breakpoint')).toBeTruthy();
    expect(screen.getByLabelText('Weight 50%')).toBeTruthy();
    expect(canvas.querySelectorAll('.fdw-graph-flow')).toHaveLength(1);
  });
});

describe('searchItems', () => {
  it('finds by words, the titles first', () => {
    const items = [
      {
        id: 'a',
        title: 'Set anger',
        category: 'action',
        keywords: ['var.set'],
      },
      { id: 'b', title: 'Get anger', category: 'value' },
      { id: 'c', title: 'roar', detail: 'The anger of the guard' },
    ];
    expect(searchItems(items, 'anger').map((i) => i.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(searchItems(items, 'get').map((i) => i.id)).toEqual(['b']);
    expect(searchItems(items, 'set ang').map((i) => i.id)).toEqual(['a']);
    expect(searchItems(items, 'var.set').map((i) => i.id)).toEqual(['a']);
    expect(searchItems(items, 'nothing')).toEqual([]);
  });
});
