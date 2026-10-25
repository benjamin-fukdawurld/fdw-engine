import { stubLayout } from '@fdw/editor-ui/testing';
import {
  actionNode,
  BehaviorGraphBuilder,
  BehaviorSystem,
  createBehaviorRegistry,
} from '@fdw/engine-behavior';
import type { BehaviorGraphTarget } from '@fdw/engine-graph-editing';
import { renderGraphEditor, stubGraphDom } from '@fdw/graph-editor/testing';
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  behaviorGraphPlugin,
  behaviorGraphView,
  breakpointCommand,
  continueCommand,
  debuggingKey,
  pausedKey,
  stepCommand,
} from './index';
import { shortValue } from './main';

beforeAll(() => {
  stubLayout();
  stubGraphDom();
});

// An orc counts its steps and roars at each one.
function orcs() {
  const roars: number[] = [];
  const roar = actionNode({
    id: 'game.roar',
    category: 'game',
    run: (call) => {
      roars.push(call.self.entity);
    },
  });
  const registry = createBehaviorRegistry([roar]);
  const g = new BehaviorGraphBuilder('orcs', registry);
  g.variable('steps', 'number');
  const update = g.onUpdate({ id: 'update' });
  const count = g.set(update.then, 'steps', g.add(g.get('steps'), 1), {
    id: 'count',
  });
  g.node('game.roar', { from: count.then }, { id: 'roar' });
  const system = new BehaviorSystem(g.build(), { host: {}, registry });
  system.attach(1);
  system.attach(2);
  const target: BehaviorGraphTarget = {
    kind: 'behavior',
    id: 'tps/enemies',
    name: 'Enemies',
    system,
    registry,
    entityName: (entity) => `orc ${entity}`,
  };
  return { system, target, roars };
}

describe('the behavior plugin', () => {
  afterEach(cleanup);

  it('debugs the graph of the scene: a breakpoint, the pause, a step', async () => {
    const { system, target, roars } = orcs();
    const { runtime, frame } = await renderGraphEditor(
      [behaviorGraphPlugin],
      [target],
    );
    await act(() => runtime.workbench.openView(behaviorGraphView));
    const roar = await screen.findByRole('group', { name: 'roar' });
    fireEvent.click(screen.getByRole('button', { name: 'Debug' }));
    await waitFor(() => expect(runtime.keys.values()[debuggingKey]).toBe(true));
    // F9 on the node selected: a breakpoint.
    fireEvent.pointerDown(roar, { button: 0 });
    fireEvent.pointerUp(window, { button: 0 });
    await act(() => runtime.commands.execute(breakpointCommand));
    expect(await screen.findByLabelText('Breakpoint')).toBeTruthy();
    act(() => system.run(0.1));
    await waitFor(() => expect(runtime.keys.values()[pausedKey]).toBe(true));
    expect(
      screen.getByText('Stopped before roar (breakpoint): the scene waits.'),
    ).toBeTruthy();
    expect(screen.getByLabelText('Paused here')).toBeTruthy();
    // The states of the nodes that ran.
    expect(screen.getAllByText('1×').length).toBeGreaterThan(0);
    expect(roars).toEqual([]);
    await act(() => runtime.commands.execute(stepCommand));
    expect(roars).toEqual([1]);
    // Going on: the next run stops at the breakpoint again.
    await act(() => runtime.commands.execute(continueCommand));
    frame();
    await waitFor(() =>
      expect(runtime.keys.values()[pausedKey]).toBeUndefined(),
    );
    expect(screen.getByText(/^Running/)).toBeTruthy();
    expect(screen.getByText('steps')).toBeTruthy();
  });

  it('edits the variables and the functions of the graph', async () => {
    const { system, target } = orcs();
    const { runtime } = await renderGraphEditor(
      [behaviorGraphPlugin],
      [target],
    );
    await act(() => runtime.workbench.openView(behaviorGraphView));
    await screen.findByRole('group', { name: 'roar' });
    fireEvent.click(screen.getByRole('tab', { name: 'Variables' }));
    fireEvent.click(screen.getByRole('button', { name: /Variable/ }));
    await waitFor(() =>
      expect(system.graph.variables?.map((v) => v.name)).toEqual([
        'steps',
        'value2',
      ]),
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Functions' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New function' }), {
      target: { value: 'growl' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    // Its body shown, with its ports.
    expect(await screen.findByRole('group', { name: 'Inputs' })).toBeTruthy();
    expect(
      screen.getByRole('combobox', { name: 'Function shown' }),
    ).toHaveProperty('value', 'growl');
    fireEvent.click(screen.getByRole('button', { name: 'Input' }));
    await waitFor(() =>
      expect(system.graph.functions?.[0].inputs).toEqual([
        { name: 'p1', type: 'number' },
      ]),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Back to the graph' }));
    expect(await screen.findByRole('group', { name: 'roar' })).toBeTruthy();
  });

  it('writes the values of the debugger short', () => {
    expect(shortValue(1 / 3)).toBe('0.33');
    expect(shortValue('chase')).toBe('"chase"');
    expect(shortValue({ x: 1, y: 2.555, z: 0 })).toBe('(1, 2.56, 0)');
  });
});
