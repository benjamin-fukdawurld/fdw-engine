import {
  AnimationClip,
  AnimationGraphBuilder,
  Animator,
  Skeleton,
} from '@fdw/engine-animation';
import {
  actionNode,
  BehaviorGraphBuilder,
  BehaviorSystem,
  createBehaviorRegistry,
} from '@fdw/engine-behavior';
import type { RenderBackend } from '@fdw/engine-backend';
import { Material, Mesh } from '@fdw/engine-core';
import { fakeBackend } from '@fdw/engine-core/testing';
import {
  BuiltinTypes,
  GraphBuilder,
  type MaterialGraphData,
  std,
} from '@fdw/engine-shader';
import { WgslCodegen, wgslLayoutStrategy } from '@fdw/engine-webgpu';
import { describe, expect, it } from 'vitest';
import { GraphWorkspace } from './GraphWorkspace';
import { sourceMap } from './live/material';
import type { GraphEvent, GraphRequest, GraphView } from './protocol';
import {
  animatorsTarget,
  type BehaviorGraphTarget,
  itemsMaterialTarget,
} from './targets';

// A backend without GPU that writes WGSL: the code of the materials.
function backend(): RenderBackend {
  const fake = fakeBackend().backend;
  return {
    ...fake,
    pipelines: {
      ...fake.pipelines,
      codegen: new WgslCodegen(),
      resolveLayout: (program) => wgslLayoutStrategy.resolve(program.layout),
    },
  };
}

// A quad with positions, normals and uvs.
const quad = () =>
  new Mesh({
    description: {
      vertexBuffers: [
        {
          stride: 32,
          stepMode: 'vertex',
          attributes: [
            { semantic: 'position', format: 'float32x3', offset: 0 },
            { semantic: 'normal', format: 'float32x3', offset: 12 },
            { semantic: 'uv', format: 'float32x2', offset: 24 },
          ],
        },
      ],
      vertexCount: 4,
      indexBuffer: { format: 'uint16', count: 6 },
    },
    vertices: [new Float32Array(32)],
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
  });

function workspace(options: { backend?: RenderBackend } = {}) {
  const events: { event: GraphEvent; data?: Uint8Array }[] = [];
  const meshes = { sphere: quad(), cube: quad(), plane: quad() };
  const ws = new GraphWorkspace({
    post: (event, data) => events.push({ event, ...(data && { data }) }),
    ...(options.backend && { backend: options.backend, meshes }),
  });
  const send = (request: GraphRequest) => ws.receive(request);
  const last = <O extends GraphEvent['op']>(op: O) =>
    events
      .map((e) => e.event)
      .filter((e): e is Extract<GraphEvent, { op: O }> => e.op === op)
      .at(-1);
  const view = (): GraphView => {
    const graph = last('graph');
    if (!graph) throw new Error('No view');
    return graph.view;
  };
  return { ws, events, send, last, view };
}

const tinted = (): MaterialGraphData => {
  const g = new GraphBuilder('tinted');
  const tint = g.uniform('tint', BuiltinTypes.vec3f, {
    slot: 'material',
    default: [1, 0.5, 0.2],
  });
  g.surface({
    shadingModel: 'unlit',
    baseColor: g.call(std.mul, { a: tint, b: 0.5 }, { label: 'half' }),
  });
  return g.build();
};

describe('sourceMap', () => {
  it('finds the nodes of the lines marked', () => {
    const code = 'let a = 1; // #n1\nlet b = a; // #c3\n\nlet c = b; // #n2/n4';
    expect(sourceMap(code)).toEqual({ 1: 'n1', 2: 'c3', 4: 'n2/n4' });
    expect(sourceMap(code, new Set(['n1']))).toEqual({ 1: 'n1' });
  });
});

describe('GraphWorkspace', () => {
  it('opens a new graph and a file, saves them', () => {
    const { send, last, view } = workspace();
    send({ op: 'open', session: 'b', kind: 'behavior', create: 'brain' });
    expect(view()).toMatchObject({
      name: 'brain',
      kind: 'behavior',
      errors: 0,
    });
    expect(last('catalog')?.templates.length).toBeGreaterThan(30);
    send({ op: 'save', session: 'b' });
    const file = last('file');
    expect(file?.name).toBe('brain.behavior.json');
    send({
      op: 'open',
      session: 'b',
      kind: 'behavior',
      file: { name: 'copy.behavior.json', text: file?.text ?? '' },
    });
    expect(view()).toMatchObject({ name: 'brain', file: 'copy.behavior.json' });
    send({
      op: 'command',
      session: 'b',
      command: { op: 'field', key: 'name', value: 'mind' },
    });
    expect(view().dirty).toBe(true);
    send({ op: 'saved', session: 'b', name: 'mind.behavior.json' });
    expect(view()).toMatchObject({ dirty: false, file: 'mind.behavior.json' });
    // A file that is not a graph.
    send({
      op: 'open',
      session: 'b',
      kind: 'behavior',
      file: { name: 'x.json', text: '{}' },
    });
    expect(last('closed')?.message).toMatch(/Unsupported document format/);
  });

  it('refuses a connection, with the message of the validation', () => {
    const { send, last } = workspace();
    send({ op: 'open', session: 'm', kind: 'material', create: 'm' });
    send({
      op: 'command',
      session: 'm',
      command: {
        op: 'connect',
        from: { node: 'surface', port: 'nope' },
        to: { node: 'color', port: 'value' },
      },
    });
    expect(last('refused')).toEqual({
      op: 'refused',
      session: 'm',
      message: 'No output "nope" on #surface',
    });
  });

  it('compiles a material of the scene, runs it, shows its code and its preview', async () => {
    const { ws, send, last, events } = workspace({ backend: backend() });
    const items = [
      { material: new Material({ graph: tinted() }) },
      { material: new Material({ graph: tinted() }) },
    ];
    const target = itemsMaterialTarget('gallery/tinted', 'Tinted', items);
    ws.setTargets([target]);
    expect(last('targets')?.targets).toEqual([
      { id: 'gallery/tinted', kind: 'material', name: 'Tinted' },
    ]);
    send({
      op: 'open',
      session: 'm',
      kind: 'material',
      target: 'gallery/tinted',
    });
    ws.frame(0);
    const code = last('code')?.code;
    expect(code?.language).toBe('wgsl');
    expect(code?.diagnostics).toEqual([]);
    // The line of the node `half` (the multiplication).
    const half = tinted().nodes.find((n) => n.label === 'half')?.id;
    expect(Object.values(code?.lines[0] ?? {})).toContain(half);
    const before = items[0].material;
    send({
      op: 'command',
      session: 'm',
      command: { op: 'default', node: half ?? '', port: 'b', value: 0.25 },
    });
    ws.frame(1);
    // The material made again, with the values of the first; only the
    // items drawn with it.
    expect(items[0].material).not.toBe(before);
    expect(
      items[0].material.graph.nodes.find((n) => n.id === half)?.defaults,
    ).toEqual({ b: 0.25 });
    expect(items[1].material).not.toBe(items[0].material);

    // A graph that does not compile is not drawn.
    const drawn = items[0].material;
    const tint = tinted().nodes.find((n) => n.type === 'input.uniform')?.id;
    send({
      op: 'command',
      session: 'm',
      command: {
        op: 'params',
        node: tint ?? '',
        params: { type: 'vec4<f32>' },
      },
    });
    ws.frame(2);
    expect(last('code')?.code.diagnostics.length).toBeGreaterThan(0);
    expect(items[0].material).toBe(drawn);
    send({ op: 'command', session: 'm', command: { op: 'undo' } });
    ws.frame(3);

    send({ op: 'preview', session: 'm', shape: 'cube', animate: false });
    ws.frame(3.05);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const preview = events.find((e) => e.event.op === 'preview');
    expect(preview?.event).toEqual({
      op: 'preview',
      session: 'm',
      width: 256,
      height: 256,
    });
    expect(preview?.data?.byteLength).toBe(256 * 256 * 4);
  });

  it('plays an animation graph edited, and tells its states and weights', () => {
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
    const clips = [clip('Idle'), clip('Run')];
    const g = new AnimationGraphBuilder('hero');
    g.parameter('speed', 'number');
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
    const hero = new Animator(graph, { skeleton, clips });
    const target = animatorsTarget('tps/hero', 'Hero', {
      graph: () => graph,
      animators: () => [{ name: 'hero', animator: hero }],
      onApply: (next) => (graph = next),
    });
    const { ws, send, last, view } = workspace();
    ws.setTargets([target]);
    send({ op: 'open', session: 'a', kind: 'animation', target: 'tps/hero' });
    send({
      op: 'animation',
      session: 'a',
      parameter: { name: 'speed', value: 2 },
    });
    hero.update(0.1);
    ws.frame(0.5);
    const live = last('animation')?.live;
    const machine = graph.nodes.find((n) => n.label === 'body')?.id ?? '';
    expect(live?.animators).toEqual(['hero']);
    expect(live?.machines[machine]?.state).toBe('run');
    expect(live?.parameters).toEqual({ speed: 2 });
    const run = graph.nodes.find((n) => n.params['clip'] === 'Run')?.id ?? '';
    expect(live?.nodes[run]?.weight).toBe(1);
    // A clip the animator does not have: not played, and said.
    send({
      op: 'command',
      session: 'a',
      command: { op: 'params', node: run, params: { clip: 'Fly' } },
    });
    expect(view().applyError).toMatch(/no clip "Fly"/);
    expect(hero.graph).toBe(graph);
    send({
      op: 'command',
      session: 'a',
      command: { op: 'params', node: run, params: { clip: 'Idle' } },
    });
    expect(view().applyError).toBeUndefined();
    expect(hero.graph).toBe(graph);
    expect(graph.nodes.find((n) => n.id === run)?.params['clip']).toBe('Idle');
  });

  it('debugs a behavior graph: breakpoints, the pause, the steps, the states', () => {
    const calls: string[] = [];
    const say = actionNode({
      id: 'test.say',
      run: (call) => {
        calls.push(`${call.self.entity}`);
      },
    });
    const registry = createBehaviorRegistry([say]);
    const b = new BehaviorGraphBuilder('brain', registry);
    b.variable('count', 'number');
    b.function('count', {}, (f) => {
      const start = f.inputs();
      const set = f.set(start.exec('exec'), 'count', f.add(f.get('count'), 1), {
        id: 'add',
      });
      f.outputs(set.then);
    });
    const update = b.onUpdate({ id: 'update' });
    const count = b.call(update.then, 'count', {}, { id: 'call' });
    b.node('test.say', { from: count.then }, { id: 'say' });
    const system = new BehaviorSystem(b.build(), { host: {}, registry });
    system.attach(3);
    system.attach(5);
    const target: BehaviorGraphTarget = {
      kind: 'behavior',
      id: 'brain',
      name: 'Brain',
      system,
      registry,
      entityName: (entity) => `orc ${entity}`,
    };
    const { ws, send, last } = workspace();
    ws.setTargets([target]);
    send({ op: 'open', session: 'b', kind: 'behavior', target: 'brain' });
    send({ op: 'debug', session: 'b', action: 'attach' });
    send({ op: 'debug', session: 'b', action: 'follow', entity: 5 });
    send({
      op: 'debug',
      session: 'b',
      action: 'breakpoint',
      node: 'say',
      on: true,
    });
    let state = last('debug')?.state;
    expect(state).toMatchObject({
      attached: true,
      instances: [
        { entity: 3, name: 'orc 3' },
        { entity: 5, name: 'orc 5' },
      ],
      entity: 5,
      breakpoints: ['say'],
    });
    system.run(0.1);
    expect(ws.paused).toBe(true);
    state = last('debug')?.state;
    expect(state?.paused).toEqual({
      entity: 5,
      node: 'say',
      reason: 'breakpoint',
    });
    expect(state?.variables).toEqual({ count: 1 });
    expect(state?.trace).toEqual(['update']);
    expect(calls).toEqual(['3']);
    send({ op: 'debug', session: 'b', action: 'step' });
    expect(calls).toEqual(['3', '5']);
    expect(ws.paused).toBe(false);
    // The step would stop before the next node: no more steps.
    send({ op: 'debug', session: 'b', action: 'continue' });
    // In the body of the function, at its call.
    send({
      op: 'command',
      session: 'b',
      command: { op: 'scope', scope: 'count' },
    });
    send({
      op: 'debug',
      session: 'b',
      action: 'breakpoint',
      node: 'add',
      scope: 'count',
      on: true,
    });
    system.run(0.1);
    state = last('debug')?.state;
    expect(state).toMatchObject({
      paused: { entity: 5, node: 'add' },
      call: 'call',
      breakpoints: ['add'],
    });
    expect(state?.nodes['add']).toMatchObject({ runs: 1 });
    send({ op: 'debug', session: 'b', action: 'continue' });
    expect(ws.paused).toBe(true);
    send({ op: 'debug', session: 'b', action: 'detach' });
    expect(ws.paused).toBe(false);
    expect(system.mode).toBe('compile');
    // Edited while it runs: the new graph runs, the variables kept.
    send({ op: 'command', session: 'b', command: { op: 'scope' } });
    send({
      op: 'command',
      session: 'b',
      command: { op: 'remove', ids: ['say'] },
    });
    expect(system.graph.nodes.map((n) => n.id)).not.toContain('say');
    expect(system.instance(5)?.get('count')).toBe(2);
    // The scene goes: the session goes on with its document.
    ws.setTargets([]);
    expect(last('graph')?.view.target).toBeUndefined();
    send({ op: 'debug', session: 'b', action: 'attach' });
    expect(last('refused')?.message).toBe(
      'Only the graphs of the scene are debugged',
    );
  });
});
