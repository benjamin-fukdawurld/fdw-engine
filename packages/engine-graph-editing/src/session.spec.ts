import {
  AnimationGraphBuilder,
  type AnimationGraphData,
} from '@fdw/engine-animation';
import {
  actionNode,
  BehaviorGraphBuilder,
  type BehaviorGraphData,
  createBehaviorRegistry,
} from '@fdw/engine-behavior';
import { copyFragment, formatDiagnostic } from '@fdw/engine-graph';
import {
  BuiltinTypes,
  GraphBuilder,
  type MaterialGraphData,
  std,
} from '@fdw/engine-shader';
import { describe, expect, it } from 'vitest';
import { GraphSession } from './GraphSession';
import { animationGraphKind } from './kinds/animation';
import { behaviorGraphKind } from './kinds/behavior';
import {
  acceptsMaterialType,
  materialGraphKind,
  parseShaderType,
} from './kinds/material';

const roar = actionNode({
  id: 'game.roar',
  category: 'game',
  run: () => undefined,
});
const registry = createBehaviorRegistry([roar]);

// A guard: its anger rises at each hit; past 50, it roars.
function guard(): BehaviorGraphData {
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

const behavior = () =>
  new GraphSession('s', behaviorGraphKind(registry), guard());

describe('GraphSession', () => {
  it('lays out a graph made in code, and projects its nodes and ports', () => {
    const session = behavior();
    const view = session.projection();
    expect(view.kind).toBe('behavior');
    expect(view.name).toBe('guard');
    expect(view.nodes).toHaveLength(guard().nodes.length);
    // Every node placed, from the event on.
    const positions = view.layout.nodes ?? {};
    expect(Object.keys(positions).sort()).toEqual(
      view.nodes.map((n) => n.id).sort(),
    );
    expect(positions['roar'].x).toBeGreaterThan(positions['hit'].x);
    const hit = view.nodes.find((n) => n.id === 'hit');
    expect(hit?.title).toBe('On hit');
    expect(hit?.outputs.map((p) => [p.name, p.type, p.exec])).toEqual([
      ['then', 'exec', true],
      ['damage', 'number', undefined],
    ]);
    const angry = view.nodes.find((n) => n.id === 'angry');
    expect(angry?.title).toBe('Set anger');
    expect(angry?.inputs[0]).toMatchObject({
      name: 'exec',
      connections: 'many',
    });
    expect(view.diagnostics).toEqual([]);
    expect(view.dirty).toBe(false);
    expect(view.fields['variables']).toEqual([
      { name: 'anger', type: 'number' },
    ]);
  });

  it('adds nodes from the templates, undoes and redoes', () => {
    const session = behavior();
    const templates = session.templates();
    expect(templates.map((t) => t.title)).toEqual(
      expect.arrayContaining(['Get anger', 'Set anger', 'On hit', 'roar']),
    );
    const get = templates.find((t) => t.title === 'Get anger');
    expect(get?.outputs).toEqual([
      { name: 'value', type: 'number', connections: 'many' },
    ]);
    expect(
      session.execute({
        op: 'add',
        template: 'var.get:anger',
        at: { x: 10, y: 20 },
      }),
    ).toEqual({});
    let view = session.projection();
    const added = view.nodes.at(-1);
    expect(added).toMatchObject({ type: 'var.get', title: 'Get anger' });
    expect(view.layout.nodes?.[added?.id ?? '']).toEqual({ x: 10, y: 20 });
    expect(view.undo).toBe('Add Get anger');
    expect(view.dirty).toBe(true);
    session.execute({ op: 'undo' });
    view = session.projection();
    expect(view.nodes).toHaveLength(guard().nodes.length);
    expect(view.redo).toBe('Add Get anger');
    session.execute({ op: 'redo' });
    expect(session.projection().nodes.at(-1)?.type).toBe('var.get');
  });

  it('adds a node connected to the port it was dragged from', () => {
    const session = behavior();
    session.execute({
      op: 'add',
      template: 'game.roar',
      at: { x: 0, y: 0 },
      connect: { port: { node: 'check', port: 'false' }, side: 'output' },
    });
    const view = session.projection();
    const roar2 = view.nodes.at(-1)?.id;
    expect(view.edges).toContainEqual({
      from: { node: 'check', port: 'false' },
      to: { node: roar2, port: 'exec' },
    });
  });

  it('refuses the connections the types refuse, and replaces an input', () => {
    const session = behavior();
    // A number into a boolean.
    const refused = session.execute({
      op: 'connect',
      from: { node: 'hit', port: 'damage' },
      to: { node: 'check', port: 'condition' },
    });
    expect(refused.refused).toMatch(/expected boolean, got number/);
    // The flow into a value.
    expect(
      session.execute({
        op: 'connect',
        from: { node: 'hit', port: 'then' },
        to: { node: 'check', port: 'condition' },
      }).refused,
    ).toBe('The flow of execution goes into an exec input');
    expect(session.projection().undo).toBeUndefined();
    // An exec output goes on to one node: the new edge replaces the old.
    session.execute({
      op: 'connect',
      from: { node: 'check', port: 'true' },
      to: { node: 'angry', port: 'exec' },
    });
    const edges = session.projection().edges;
    expect(
      edges.filter((e) => e.from.node === 'check' && e.from.port === 'true'),
    ).toEqual([
      {
        from: { node: 'check', port: 'true' },
        to: { node: 'angry', port: 'exec' },
      },
    ]);
  });

  it('merges the moves of the same nodes, and the typing in a field', () => {
    const session = behavior();
    session.execute({ op: 'move', positions: { hit: { x: 1, y: 1 } } });
    session.execute({ op: 'move', positions: { hit: { x: 2, y: 2 } } });
    session.execute({ op: 'label', node: 'roar', label: 'R' });
    session.execute({ op: 'label', node: 'roar', label: 'Roar' });
    expect(session.history.undoLabels).toEqual(['Move', 'Rename']);
    expect(session.projection().nodes.find((n) => n.id === 'roar')?.title).toBe(
      'Roar',
    );
    session.execute({ op: 'undo' });
    session.execute({ op: 'undo' });
    expect(session.projection().layout.nodes?.['hit']).not.toEqual({
      x: 1,
      y: 1,
    });
    expect(session.dirty).toBe(false);
  });

  it('removes nodes, pastes copies, groups and notes', () => {
    const session = behavior();
    const body = session.kind.body(session.document);
    const fragment = copyFragment(body, ['check', 'roar']);
    session.execute({ op: 'paste', fragment, at: { x: 500, y: 500 } });
    let view = session.projection();
    expect(view.nodes).toHaveLength(guard().nodes.length + 2);
    const pasted = view.nodes.slice(-2).map((n) => n.id);
    expect(view.edges).toContainEqual({
      from: { node: pasted[0], port: 'true' },
      to: { node: pasted[1], port: 'exec' },
    });
    session.execute({
      op: 'group',
      group: { id: 'g1', title: 'Copies', nodes: pasted },
    });
    session.execute({
      op: 'note',
      note: { id: 'note1', x: 0, y: -100, width: 200, height: 60, text: 'Hi' },
    });
    session.execute({ op: 'remove', ids: [pasted[0], 'note1'] });
    view = session.projection();
    expect(view.nodes.map((n) => n.id)).not.toContain(pasted[0]);
    expect(view.layout.notes).toEqual([]);
    expect(view.layout.groups).toEqual([
      { id: 'g1', title: 'Copies', nodes: [pasted[1]] },
    ]);
    expect(view.undo).toBe('Delete 2 items');
  });

  it('edits the parameters and the defaults, and tells the problems', () => {
    const session = behavior();
    session.execute({ op: 'params', node: 'angry', params: { name: 'rage' } });
    const view = session.projection();
    expect(view.diagnostics.map(formatDiagnostic)).toEqual([
      'error: #angry: unknown variable "rage"',
    ]);
    expect(view.errors).toBe(1);
    session.execute({
      op: 'field',
      key: 'variables',
      value: [
        { name: 'anger', type: 'number' },
        { name: 'rage', type: 'number' },
      ],
    });
    expect(session.projection().errors).toBe(0);
    session.execute({
      op: 'default',
      node: 'check',
      port: 'condition',
      value: true,
    });
    const check = session.projection().nodes.find((n) => n.id === 'check');
    expect(check?.defaults).toEqual({ condition: true });
    expect(
      session.execute({ op: 'field', key: 'nope', value: 1 }).refused,
    ).toBe('A behavior graph has no field "nope"');
  });

  it('arranges the nodes again', () => {
    const session = behavior();
    session.execute({ op: 'move', positions: { roar: { x: -500, y: 0 } } });
    session.execute({ op: 'layout' });
    const positions = session.projection().layout.nodes ?? {};
    expect(positions['roar'].x).toBeGreaterThan(positions['hit'].x);
    expect(session.projection().undo).toBe('Arrange');
  });

  it('creates functions, edits their bodies and their signatures, calls them', () => {
    const session = behavior();
    session.execute({ op: 'function', name: 'calm', change: 'create' });
    expect(session.projection().scopes.map((s) => s.id)).toEqual([
      undefined,
      'calm',
    ]);
    session.execute({
      op: 'function',
      name: 'calm',
      change: { inputs: [{ name: 'by', type: 'number' }] },
    });
    session.execute({ op: 'scope', scope: 'calm' });
    let view = session.projection();
    expect(view.scope).toBe('calm');
    expect(view.nodes.map((n) => n.title)).toEqual(['Inputs', 'Outputs']);
    expect(view.nodes[0].outputs.map((p) => p.name)).toEqual(['exec', 'by']);
    // Its body: anger -= by.
    session.execute({
      op: 'add',
      template: 'var.set:anger',
      at: { x: 180, y: 0 },
    });
    session.execute({ op: 'add', template: 'math.sub', at: { x: 0, y: 120 } });
    session.execute({
      op: 'add',
      template: 'var.get:anger',
      at: { x: 0, y: 240 },
    });
    view = session.projection();
    const [set, sub, get] = view.nodes.slice(-3).map((n) => n.id);
    for (const [from, to] of [
      [
        { node: 'inputs', port: 'exec' },
        { node: set, port: 'exec' },
      ],
      [
        { node: set, port: 'then' },
        { node: 'outputs', port: 'then' },
      ],
      [
        { node: get, port: 'value' },
        { node: sub, port: 'a' },
      ],
      [
        { node: 'inputs', port: 'by' },
        { node: sub, port: 'b' },
      ],
      [
        { node: sub, port: 'value' },
        { node: set, port: 'value' },
      ],
    ]) {
      expect(session.execute({ op: 'connect', from, to })).toEqual({});
    }
    expect(session.projection().errors).toBe(0);
    // Called from the graph: its template, without itself.
    expect(session.templates().some((t) => t.type === 'call.calm')).toBe(false);
    session.execute({ op: 'scope' });
    expect(
      session
        .templates()
        .find((t) => t.type === 'call.calm')
        ?.inputs.map((p) => p.name),
    ).toEqual(['exec', 'by']);
    // Renamed: its calls follow, the scope too.
    session.execute({ op: 'add', template: 'call.calm', at: { x: 0, y: 400 } });
    session.execute({ op: 'scope', scope: 'calm' });
    session.execute({
      op: 'function',
      name: 'calm',
      change: { name: 'soothe' },
    });
    expect(session.scope).toBe('soothe');
    session.execute({ op: 'scope' });
    expect(session.projection().nodes.at(-1)?.type).toBe('call.soothe');
    // A macro: the entry and the exit become ports of its signature.
    session.execute({
      op: 'function',
      name: 'soothe',
      change: { kind: 'macro' },
    });
    const fields = session.projection().fields['functions'] as {
      kind: string;
      inputs: { name: string }[];
    }[];
    expect(fields[0].kind).toBe('macro');
    expect(fields[0].inputs.map((p) => p.name)).toEqual(['exec', 'by']);
    expect(session.projection().errors).toBe(0);
    // Undone back to no function: the scope of the graph.
    while (session.history.canUndo) session.execute({ op: 'undo' });
    expect(session.projection().scopes).toHaveLength(1);
    expect(session.scope).toBeUndefined();
  });
});

describe('the material graphs', () => {
  const graph = (): MaterialGraphData => {
    const g = new GraphBuilder('tinted');
    const tint = g.uniform('tint', BuiltinTypes.vec3f, {
      slot: 'material',
      default: [1, 0.5, 0.2],
    });
    const scaled = g.call(std.mul, { a: tint, b: 0.5 });
    g.surface({ shadingModel: 'unlit', baseColor: scaled });
    return g.build();
  };

  it('shows the types of the ports resolved, and the types by name', () => {
    const session = new GraphSession('m', materialGraphKind(), graph());
    const view = session.projection();
    const mul = view.nodes.find((n) => n.type === 'std.mul');
    expect(mul?.title).toBe('mul');
    expect(mul?.inputs.map((p) => p.type)).toEqual(['vec3<f32>', 'vec3<f32>']);
    const uniform = view.nodes.find((n) => n.type === 'input.uniform');
    expect(uniform?.title).toBe('tint');
    expect(uniform?.params['type']).toBe('vec3<f32>');
    expect(uniform?.schema.find((p) => p.name === 'type')?.values).toContain(
      'vec4<f32>',
    );
    // Edited by name, held as a type.
    session.execute({
      op: 'params',
      node: uniform?.id ?? '',
      params: { type: 'f32' },
    });
    const edited = session.kind
      .body(session.document)
      .nodes.find((n) => n.id === uniform?.id);
    expect(edited?.params['type']).toEqual(BuiltinTypes.f32);
    expect(
      session.execute({
        op: 'params',
        node: uniform?.id ?? '',
        params: { type: 'vec9' },
      }).refused,
    ).toBe('Unknown type "vec9"');
  });

  it('refuses a connection whose types do not fit', () => {
    const session = new GraphSession('m', materialGraphKind(), graph());
    session.execute({
      op: 'add',
      template: 'const.value:vec4',
      at: { x: 0, y: 0 },
    });
    const view = session.projection();
    const constant = view.nodes.at(-1)?.id ?? '';
    const mul = view.nodes.find((n) => n.type === 'std.mul')?.id ?? '';
    const result = session.execute({
      op: 'connect',
      from: { node: constant, port: 'value' },
      to: { node: mul, port: 'b' },
    });
    expect(result.refused).toMatch(/vec4<f32>/);
  });

  it('offers templates of the types and of the shading models', () => {
    const session = new GraphSession('m', materialGraphKind(), graph());
    const titles = session.templates().map((t) => t.title);
    expect(titles).toEqual(
      expect.arrayContaining([
        'vec3 constant',
        'uniform vec4',
        'surface (pbr)',
        'time',
        'smoothstep',
      ]),
    );
    expect(parseShaderType('vec2<u32>')).toEqual({
      kind: 'vector',
      size: 2,
      scalar: 'u32',
    });
    expect(acceptsMaterialType('f32', 'vec3<f32>')).toBe(true);
    expect(acceptsMaterialType('vec4<f32>', 'vec3<f32>')).toBe(false);
    expect(acceptsMaterialType('T: float', 'vec3<f32>')).toBe(true);
  });

  it('makes a new graph that compiles, and its functions', () => {
    const kind = materialGraphKind();
    const session = new GraphSession('m', kind, kind.create('new'));
    expect(session.projection().errors).toBe(0);
    session.execute({ op: 'function', name: 'my.wave', change: 'create' });
    session.execute({ op: 'scope', scope: 'my.wave' });
    expect(session.projection().nodes.map((n) => n.title)).toEqual([
      'input x',
      'output result',
    ]);
    session.execute({ op: 'scope' });
    expect(session.templates().some((t) => t.type === 'my.wave')).toBe(true);
  });
});

describe('the animation graphs', () => {
  const graph = (): AnimationGraphData => {
    const g = new AnimationGraphBuilder('hero');
    g.parameter('speed', 'number');
    const machine = g.stateMachine({
      label: 'body',
      states: { idle: g.clip('Idle'), run: g.clip('Run') },
      transitions: [
        {
          from: 'idle',
          to: 'run',
          conditions: [{ parameter: 'speed', op: '>', value: 1 }],
        },
      ],
    });
    g.output(machine);
    return g.build();
  };

  it('shows the states as ports, and edits the transitions as parameters', () => {
    const session = new GraphSession('a', animationGraphKind(), graph());
    const view = session.projection();
    const machine = view.nodes.find((n) => n.type === 'anim.stateMachine');
    expect(machine?.title).toBe('body');
    expect(machine?.inputs.map((p) => [p.name, p.type])).toEqual([
      ['idle', 'pose'],
      ['run', 'pose'],
    ]);
    session.execute({ op: 'add', template: 'anim.clip', at: { x: 0, y: 0 } });
    expect(session.projection().nodes.at(-1)?.title).toBe('Clip Idle');
    session.execute({ op: 'undo' });
    session.execute({
      op: 'params',
      node: machine?.id ?? '',
      params: { transitions: [{ from: 'run', to: 'nowhere' }] },
    });
    expect(session.projection().diagnostics.map((d) => d.message)).toEqual([
      expect.stringMatching(/nowhere/),
    ]);
    expect(session.templates().map((t) => t.title)).toEqual(
      expect.arrayContaining(['Clip', 'speed', 'State machine', 'Blend space']),
    );
  });
});
