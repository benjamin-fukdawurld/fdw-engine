import { stubLayout } from '@fdw/editor-ui/testing';
import {
  AnimationClip,
  AnimationGraphBuilder,
  Animator,
  Skeleton,
} from '@fdw/engine-animation';
import { animatorsTarget } from '@fdw/engine-graph-editing';
import { renderGraphEditor, stubGraphDom } from '@fdw/graph-editor/testing';
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { animationGraphPlugin, animationGraphView } from './index';
import { animationOverlay } from './main';

beforeAll(() => {
  stubLayout();
  stubGraphDom();
});

// A hero who idles, then runs past a speed.
function hero() {
  const skeleton = new Skeleton([
    { name: 'root' },
    { name: 'hips', parent: 0 },
  ]);
  const clip = (name: string) =>
    new AnimationClip({
      name,
      tracks: [
        {
          joint: 1,
          path: 'translation',
          interpolation: 'LINEAR',
          times: new Float32Array([0, 1]),
          values: new Float32Array([0, 0, 0, 1, 0, 0]),
        },
      ],
    });
  const g = new AnimationGraphBuilder('hero');
  g.parameter('speed', 'number');
  g.parameter('jump', 'trigger');
  g.output(
    g.stateMachine({
      label: 'body',
      states: { idle: g.clip('Idle'), run: g.clip('Run') },
      transitions: [
        {
          from: 'idle',
          to: 'run',
          duration: 0,
          conditions: [{ parameter: 'speed', op: '>', value: 1 }],
        },
      ],
    }),
  );
  let graph = g.build();
  const animator = new Animator(graph, {
    skeleton,
    clips: [clip('Idle'), clip('Run')],
  });
  const target = animatorsTarget('tps/hero', 'Hero', {
    graph: () => graph,
    animators: () => [{ name: 'hero', animator }],
    onApply: (next) => (graph = next),
  });
  return { animator, target, graph: () => graph };
}

describe('the animation plugin', () => {
  afterEach(cleanup);

  it('shows what the animator plays, and forces its parameters', async () => {
    const { animator, target } = hero();
    const { runtime, frame } = await renderGraphEditor(
      [animationGraphPlugin],
      [target],
    );
    await act(() => runtime.workbench.openView(animationGraphView));
    await screen.findByRole('group', { name: 'body' });
    animator.update(0.1);
    frame();
    expect((await screen.findAllByText('idle')).length).toBeGreaterThan(0);
    fireEvent.change(
      screen.getByRole('spinbutton', { name: 'Parameter speed' }),
      {
        target: { value: '2' },
      },
    );
    fireEvent.keyDown(
      screen.getByRole('spinbutton', { name: 'Parameter speed' }),
      {
        key: 'Enter',
      },
    );
    expect(animator.get('speed')).toBe(2);
    animator.update(0.1);
    frame();
    // The badge of the machine on its node, the weights of the clips.
    expect((await screen.findAllByText('run')).length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText('Weight 100%').length).toBeGreaterThan(0);
  });

  it('edits the states and the transitions of a state machine', async () => {
    const { target, graph } = hero();
    const { runtime } = await renderGraphEditor(
      [animationGraphPlugin],
      [target],
    );
    await act(() => runtime.workbench.openView(animationGraphView));
    fireEvent.doubleClick(await screen.findByRole('group', { name: 'body' }));
    expect(
      await screen.findByRole('application', { name: 'body: state machine' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'State idle' })).toBeTruthy();
    // A transition back, by its tab.
    fireEvent.click(screen.getByRole('tab', { name: 'State machine' }));
    fireEvent.click(screen.getByRole('button', { name: 'Transition' }));
    const machine = () =>
      graph().nodes.find((n) => n.type === 'anim.stateMachine');
    await waitFor(() =>
      expect(machine()?.params['transitions']).toHaveLength(2),
    );
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Transition 2 from' }),
      {
        target: { value: 'run' },
      },
    );
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Transition 2 to' }),
      {
        target: { value: 'idle' },
      },
    );
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Transition 2 trigger' }),
      { target: { value: 'jump' } },
    );
    await waitFor(() =>
      expect((machine()?.params['transitions'] as unknown[])[1]).toEqual({
        from: 'run',
        to: 'idle',
        duration: 0.2,
        trigger: 'jump',
      }),
    );
    // A state renamed: its transitions and its input follow.
    const name = screen.getByRole('textbox', { name: 'State run' });
    fireEvent.change(name, { target: { value: 'sprint' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    await waitFor(() =>
      expect(machine()?.params['states']).toEqual([
        { name: 'idle' },
        { name: 'sprint' },
      ]),
    );
    expect(graph().edges.some((e) => e.to.port === 'sprint')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'hero' }));
    expect(await screen.findByRole('group', { name: 'body' })).toBeTruthy();
  });

  it('weighs the nodes by the animator', () => {
    expect(
      animationOverlay({
        animators: ['hero'],
        nodes: { a: { weight: 0.25, phase: 0 }, b: { weight: 0, phase: 0 } },
        machines: { m: { state: 'idle', next: 'run', progress: 0.5, time: 1 } },
        parameters: {},
      }),
    ).toEqual({
      nodes: {
        a: { weight: 0.25, badge: '25%' },
        b: { weight: 0, className: 'opacity-60' },
        m: { badge: 'idle → run' },
      },
    });
  });
});
