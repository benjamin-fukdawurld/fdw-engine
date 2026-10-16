import { formatDiagnostic, GraphError } from '@fdw/engine-graph';
import { describe, expect, it } from 'vitest';
import { AnimationClip } from './AnimationClip';
import { Animator } from './Animator';
import { BoneMask } from './BoneMask';
import { testSkeleton } from './testSkeleton';
import { AnimationGraphBuilder } from './graph/AnimationGraphBuilder';
import type { AnimationGraphData } from './graph/data';
import {
  parseAnimationGraph,
  serializeAnimationGraph,
  validateAnimationGraph,
} from './graph/validate';

const skeleton = testSkeleton();
const HIPS = 1;
const SPINE = 2;
const ARM = 3;
const LEG = 4;

// A clip of `duration` seconds: the hips at x = `marker` (to tell the
// clips apart), the leg along x from 0 to 1 (its phase), the arm up by
// `arm`.
const clip = (
  name: string,
  duration: number,
  marker: number,
  options: { arm?: number; events?: { time: number; name: string }[] } = {},
) =>
  new AnimationClip({
    name,
    tracks: [
      {
        joint: HIPS,
        path: 'translation',
        interpolation: 'LINEAR',
        times: new Float32Array([0, duration]),
        values: new Float32Array([marker, 1, 0, marker, 1, 0]),
      },
      {
        joint: LEG,
        path: 'translation',
        interpolation: 'LINEAR',
        times: new Float32Array([0, duration]),
        values: new Float32Array([0, 0, 0, 1, 0, 0]),
      },
      {
        joint: ARM,
        path: 'translation',
        interpolation: 'LINEAR',
        times: new Float32Array([0, duration]),
        values: new Float32Array([
          0,
          options.arm ?? 0,
          0,
          0,
          options.arm ?? 0,
          0,
        ]),
      },
    ],
    ...(options.events ? { events: options.events } : {}),
  });

const clips = [
  clip('Idle', 2, 0),
  clip('Walk', 1, 1, {
    events: [
      { time: 0, name: 'step' },
      { time: 0.5, name: 'step' },
    ],
  }),
  clip('Run', 0.5, 2, { events: [{ time: 0.25, name: 'run-step' }] }),
  clip('Jump', 0.5, 5),
  clip('Wave', 1, 0, { arm: 3, events: [{ time: 0.5, name: 'wave' }] }),
];

const hipsX = (animator: Animator) => animator.pose.translations[HIPS * 3];
const legX = (animator: Animator) => animator.pose.translations[LEG * 3];

describe('Animator', () => {
  it('loops a clip, and reaches its events through the loop', () => {
    const g = new AnimationGraphBuilder('walk');
    g.output(g.clip('Walk'));
    const animator = new Animator(g.build(), { skeleton, clips });
    // The rest pose before the first update.
    expect(animator.pose.translations[LEG * 3]).toBeCloseTo(0.1);
    animator.update(0.25);
    expect(legX(animator)).toBeCloseTo(0.25);
    expect(animator.events).toEqual([]);
    animator.update(0.5);
    expect(animator.events.map((e) => [e.name, e.time])).toEqual([
      ['step', 0.5],
    ]);
    // 0.75 → 1.25: the end, then the step at 0 of the next cycle.
    animator.update(0.5);
    expect(legX(animator)).toBeCloseTo(0.25);
    expect(animator.events.map((e) => [e.name, e.time, e.clip])).toEqual([
      ['step', 0, 'Walk'],
    ]);
    // The other joints keep the rest pose.
    expect(animator.pose.translation(SPINE)).toEqual(
      skeleton.rest.translation(SPINE),
    );
  });

  it('holds the last pose of a clip that does not loop, at the speed given', () => {
    const g = new AnimationGraphBuilder('jump');
    g.parameter('rate', 'number', 2);
    g.output(
      g.clip('Walk', { loop: false, speed: 0.5, rate: g.param('rate') }),
    );
    const animator = new Animator(g.build(), { skeleton, clips });
    animator.update(0.4);
    expect(legX(animator)).toBeCloseTo(0.4);
    animator.set('rate', 1).update(2);
    expect(legX(animator)).toBeCloseTo(1);
  });

  it('blends the two poses around the value of a blend space, in step', () => {
    const g = new AnimationGraphBuilder('locomotion');
    g.parameter('speed', 'number');
    g.output(
      g.blend1d(
        [g.clip('Idle'), g.clip('Walk'), g.clip('Run')],
        [0, 2, 4],
        g.param('speed'),
      ),
    );
    const animator = new Animator(g.build(), { skeleton, clips });
    animator.set('speed', 1).update(0.1);
    // Halfway between idle (0) and walk (1).
    expect(hipsX(animator)).toBeCloseTo(0.5);
    animator.set('speed', 3).update(0);
    expect(hipsX(animator)).toBeCloseTo(1.5);
    animator.set('speed', 10).update(0);
    expect(hipsX(animator)).toBeCloseTo(2);

    // Synchronized: walk (1 s) and run (0.5 s) halfway make a cycle of
    // 0.75 s, both at the same phase.
    const synced = new Animator(g.build(), { skeleton, clips });
    synced.set('speed', 3).update(0.3);
    expect(legX(synced)).toBeCloseTo(0.4);
    // The events of the heavier clip only. Walk at 0.6, a cycle of 0.8 s:
    // the phase goes from 0.4 to 0.65, past the steps of both at 0.5.
    synced.set('speed', 2.8).update(0.2);
    expect(legX(synced)).toBeCloseTo(0.65);
    expect(synced.events.map((e) => e.name)).toEqual(['step']);
    // Run at 0.6, a cycle of 0.7 s: from 0.65 to 1.55, past the steps of
    // the walk at 1 and of the run at 1.5.
    synced.set('speed', 3.2).update(0.63);
    expect(synced.events.map((e) => e.name)).toEqual(['run-step']);
  });

  it('blends two poses by a weight', () => {
    const g = new AnimationGraphBuilder('blend');
    g.output(g.blend(g.clip('Walk'), g.clip('Run'), 0.25));
    const animator = new Animator(g.build(), { skeleton, clips });
    animator.update(0);
    expect(hipsX(animator)).toBeCloseTo(1.25);
  });

  const machine = () => {
    const g = new AnimationGraphBuilder('character');
    g.parameter('speed', 'number');
    g.parameter('grounded', 'boolean', true);
    g.parameter('jump', 'trigger');
    const body = g.stateMachine({
      label: 'body',
      states: {
        idle: g.clip('Idle'),
        walk: g.clip('Walk'),
        jump: g.clip('Jump', { loop: false }),
      },
      transitions: [
        {
          from: 'idle',
          to: 'walk',
          duration: 0.5,
          conditions: [{ parameter: 'speed', op: '>', value: 0.1 }],
        },
        {
          from: 'walk',
          to: 'idle',
          duration: 0.5,
          conditions: [{ parameter: 'speed', op: '<=', value: 0.1 }],
        },
        {
          from: '*',
          to: 'jump',
          duration: 0,
          trigger: 'jump',
          conditions: [{ parameter: 'grounded' }],
        },
        { from: 'jump', to: 'idle', duration: 0.2, exitTime: 1 },
      ],
    });
    g.output(body);
    return g.build();
  };

  it('cross-fades between the states of a state machine', () => {
    const animator = new Animator(machine(), { skeleton, clips });
    animator.update(0.1);
    expect(animator.state('body')).toEqual({
      state: 'idle',
      progress: 0,
      time: expect.closeTo(0.1),
    });
    animator.set('speed', 1).update(0.25);
    expect(animator.state('body')).toMatchObject({
      state: 'idle',
      next: 'walk',
      progress: 0.5,
    });
    expect(hipsX(animator)).toBeCloseTo(0.5);
    animator.update(0.25);
    expect(animator.state('body')).toMatchObject({
      state: 'walk',
      progress: 0,
    });
    expect(hipsX(animator)).toBeCloseTo(1);
    // The walk restarted when entered: 0.5 s in it.
    expect(legX(animator)).toBeCloseTo(0.5);
  });

  it('consumes the triggers, and leaves a state at its exit time', () => {
    const animator = new Animator(machine(), { skeleton, clips });
    animator.update(0.1);
    animator.trigger('jump').update(0.1);
    expect(animator.state('body')?.state).toBe('jump');
    expect(animator.get('jump')).toBe(false);
    expect(hipsX(animator)).toBeCloseTo(5);
    // Not before the end of its clip (0.5 s).
    animator.update(0.3);
    expect(animator.state('body')).toMatchObject({ state: 'jump' });
    // The transitions are chosen at the start of an update: 0.55 s, then
    // the next one starts the fade.
    animator.update(0.15);
    expect(animator.state('body')).toEqual({
      state: 'jump',
      progress: 0,
      time: expect.closeTo(0.55),
    });
    animator.update(0.05);
    expect(animator.state('body')).toMatchObject({
      state: 'jump',
      next: 'idle',
    });
    // Not grounded: the trigger waits.
    animator.update(1);
    animator.set('grounded', false).trigger('jump').update(0.1);
    expect(animator.state('body')?.state).toBe('idle');
    expect(animator.get('jump')).toBe(true);
    animator.set('grounded', true).update(0.1);
    expect(animator.state('body')?.state).toBe('jump');
    animator.reset();
    expect(animator.state('body')?.state).toBe('idle');
  });

  it('layers a clip over the joints of a mask, or adds it', () => {
    const g = new AnimationGraphBuilder('waving');
    g.parameter('wave', 'number', 1);
    const walk = g.clip('Walk');
    g.output(
      g.layer(walk, g.clip('Wave'), {
        mask: 'arm',
        weight: g.param('wave'),
      }),
    );
    const masks = { arm: BoneMask.branches(skeleton, { arm: 1 }) };
    const animator = new Animator(g.build(), { skeleton, clips, masks });
    animator.update(0.6);
    // The arm waves, the legs walk; both keep their events.
    expect(animator.pose.translations[ARM * 3 + 1]).toBeCloseTo(3);
    expect(hipsX(animator)).toBeCloseTo(1);
    expect(animator.events.map((e) => e.name)).toEqual(['step', 'wave']);
    animator.set('wave', 0.5).update(0);
    expect(animator.pose.translations[ARM * 3 + 1]).toBeCloseTo(1.5);

    const additive = new AnimationGraphBuilder('nod');
    additive.output(
      additive.layer(
        additive.clip('Walk'),
        additive.clip('Wave', { additive: true }),
        {
          mode: 'additive',
        },
      ),
    );
    // Wave is constant: its difference with its first pose is nothing.
    const added = new Animator(additive.build(), { skeleton, clips });
    added.update(0.3);
    expect(hipsX(added)).toBeCloseTo(1);
    expect(added.pose.translations[ARM * 3 + 1]).toBeCloseTo(0);
  });

  it('shares a node feeding two inputs: advanced once a frame', () => {
    const g = new AnimationGraphBuilder('shared');
    const walk = g.clip('Walk');
    g.output(g.blend(walk, walk, 0.5));
    const animator = new Animator(g.build(), { skeleton, clips });
    animator.update(0.25);
    expect(legX(animator)).toBeCloseTo(0.25);
  });

  it('reports the missing clips, masks and parameters', () => {
    const g = new AnimationGraphBuilder('missing');
    g.parameter('speed', 'number');
    g.output(g.clip('Swim'));
    const graph = g.build();
    expect(() => new Animator(graph, { skeleton, clips })).toThrow(
      'The animator has no clip "Swim"',
    );
    const h = new AnimationGraphBuilder('mask');
    h.output(h.layer(h.clip('Walk'), h.clip('Walk'), { mask: 'tail' }));
    expect(() => new Animator(h.build(), { skeleton, clips })).toThrow(
      'no mask "tail"',
    );
    const animator = new Animator(machine(), { skeleton, clips });
    expect(() => animator.set('sped', 1)).toThrow('no parameter "sped"');
    expect(() => animator.set('speed', true)).toThrow('is a number');
    expect(() => animator.trigger('speed')).toThrow('is not a trigger');
  });
});

describe('animation graphs', () => {
  it('round-trips through JSON, and runs once parsed', () => {
    const graph = machine();
    const parsed = parseAnimationGraph(serializeAnimationGraph(graph));
    expect(parsed).toEqual(graph);
    expect(validateAnimationGraph(parsed).valid).toBe(true);
    expect(() => parseAnimationGraph({ ...graph, parameters: [{}] })).toThrow(
      'Malformed "parameters"',
    );
  });

  it('reports the problems of the parameters, the states and the transitions', () => {
    const graph: AnimationGraphData = {
      format: 'fdw-animation-graph',
      version: 1,
      name: 'bad',
      parameters: [
        { name: 'speed', type: 'number' },
        { name: 'speed', type: 'number' },
        { name: 'go', type: 'trigger' },
      ],
      nodes: [
        { id: 'p', type: 'anim.parameter', params: { name: 'sped' } },
        { id: 'q', type: 'anim.parameter', params: { name: 'go' } },
        { id: 'c', type: 'anim.clip', params: { clip: 'Walk' } },
        { id: 'b', type: 'anim.blend1d', params: { points: [1, 0] } },
        {
          id: 's',
          type: 'anim.stateMachine',
          params: {
            states: [{ name: 'a' }, { name: 'a' }],
            initial: 'z',
            transitions: [
              { from: 'a', to: 'nowhere', trigger: 'speed' },
              {
                from: '*',
                to: 'a',
                conditions: [
                  { parameter: 'speed', value: true },
                  { parameter: 'gone' },
                ],
              },
            ],
          },
        },
      ],
      edges: [
        { from: { node: 'c', port: 'pose' }, to: { node: 'b', port: 'pose0' } },
        {
          from: { node: 'p', port: 'value' },
          to: { node: 'b', port: 'pose1' },
        },
      ],
    };
    const messages =
      validateAnimationGraph(graph).diagnostics.map(formatDiagnostic);
    expect(messages).toEqual(
      expect.arrayContaining([
        'error: parameter "speed" is declared twice',
        'error: an animation graph has one anim.output node, not 0',
        'error: #p: unknown parameter "sped"',
        'error: #q: parameter "go" is a trigger, read as a number',
        'error: #b: the points of a blend space must increase',
        'error: #b.pose1: expected pose, got number from #p.value',
        'error: #s: state "a" is declared twice',
        'error: #s: the initial state "z" is not a state',
        'error: #s: transition 0 (a → nowhere): unknown state "nowhere"',
        'error: #s: transition 0 (a → nowhere): "speed" is not a trigger parameter',
        'error: #s: transition 1 (* → a): "speed" is a number, compared with true',
        'error: #s: transition 1 (* → a): unknown parameter "gone"',
      ]),
    );
    expect(() => new Animator(graph, { skeleton, clips })).toThrow(GraphError);
  });

  it('refuses a blend space without a point per pose', () => {
    const g = new AnimationGraphBuilder('bad');
    expect(() => g.blend1d([g.clip('Walk')], [0, 1], 0)).toThrow(
      'a point per pose',
    );
    expect(() => g.parameter('a', 'number').parameter('a', 'boolean')).toThrow(
      'already declared',
    );
  });
});

function machine(): AnimationGraphData {
  const g = new AnimationGraphBuilder('machine');
  g.parameter('speed', 'number');
  g.parameter('jump', 'trigger');
  g.output(
    g.stateMachine({
      states: { idle: g.clip('Idle'), jump: g.clip('Jump', { loop: false }) },
      transitions: [{ from: 'idle', to: 'jump', trigger: 'jump' }],
    }),
  );
  return g.build();
}
