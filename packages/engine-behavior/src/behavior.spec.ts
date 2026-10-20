import { formatDiagnostic, GraphError } from '@fdw/engine-graph';
import { MemorySource, ResourceStore } from '@fdw/engine-resources';
import { Scene } from '@fdw/engine-scene';
import { captureScene, instantiateScene } from '@fdw/engine-scene-io';
import { describe, expect, it } from 'vitest';
import {
  BehaviorGraphBuilder,
  type ExecFrom,
  type ValueInput,
} from './BehaviorGraphBuilder';
import { type BehaviorMode, BehaviorSystem } from './BehaviorSystem';
import {
  type BehaviorGraphData,
  BehaviorGraphFormat,
  BehaviorGraphVersion,
} from './data';
import { actionNode, createBehaviorRegistry, pureNode } from './nodes';
import { BehaviorError } from './program';
import { behaviorCodec } from './codec';
import { BehaviorGraphType, behaviorGraphLoader } from './resources';
import {
  parseBehaviorGraph,
  serializeBehaviorGraph,
  validateBehaviorGraph,
} from './validate';

// A host recording what the graphs do.
interface Host {
  readonly calls: string[];
  reads: number;
  remove?: (entity: number) => void;
}
const record = actionNode<Host>({
  id: 'test.record',
  params: { text: { kind: 'string', default: '' } },
  inputs: { value: { type: 'any', optional: true } },
  run: (call, value: unknown) => {
    const text = call.params['text'] as string;
    call.self.host.calls.push(value === undefined ? text : `${text}${value}`);
  },
});
// Counts its evaluations.
const counter = pureNode<Host>({
  id: 'test.counter',
  output: 'number',
  evaluate: (call) => ++call.self.host.reads,
});
// An action with two exits and a data output.
const roll = actionNode<Host>({
  id: 'test.roll',
  inputs: { value: 'number' },
  outputs: { half: 'number' },
  exits: ['low', 'high'],
  run: (call, value: number) => {
    call.outputs['half'] = value / 2;
    return value < 5 ? 'low' : 'high';
  },
});
// Removes its own entity, as an enemy that dies.
const vanish = actionNode<Host>({
  id: 'test.vanish',
  run: (call) => {
    call.self.host.remove?.(call.self.entity);
  },
});
// Returns an exit it does not have.
const wrong = actionNode<Host>({ id: 'test.wrong', run: () => 'nope' });
const registry = createBehaviorRegistry([record, counter, roll, vanish, wrong]);

const builder = (name = 'test') => new BehaviorGraphBuilder(name, registry);
const recordNode = (
  g: BehaviorGraphBuilder,
  from: ExecFrom,
  text: string,
  value?: ValueInput,
  id?: string,
) =>
  g.node(
    'test.record',
    {
      from,
      params: { text },
      ...(value !== undefined ? { inputs: { value } } : {}),
    },
    id !== undefined ? { id } : {},
  );

const run = (
  graph: BehaviorGraphData,
  mode: BehaviorMode,
  options: { maxSteps?: number; random?: () => number } = {},
) => {
  const host: Host = { calls: [], reads: 0 };
  const logs: string[] = [];
  const system = new BehaviorSystem(graph, {
    host,
    registry,
    mode,
    log: (text) => logs.push(text),
    ...options,
  });
  return { system, host, logs };
};

const doc = (
  nodes: BehaviorGraphData['nodes'],
  edges: BehaviorGraphData['edges'] = [],
  variables?: BehaviorGraphData['variables'],
): BehaviorGraphData => ({
  format: BehaviorGraphFormat,
  version: BehaviorGraphVersion,
  name: 'doc',
  nodes,
  edges,
  ...(variables ? { variables } : {}),
});
const edge = (from: string, fromPort: string, to: string, toPort: string) => ({
  from: { node: from, port: fromPort },
  to: { node: to, port: toPort },
});
const messages = (graph: BehaviorGraphData) =>
  validateBehaviorGraph(graph, registry).diagnostics.map(formatDiagnostic);

describe('validateBehaviorGraph', () => {
  it('lets the flow loop and join, not an exec output go twice', () => {
    const nodes = [
      { id: 's', type: 'event.start', params: {} },
      { id: 'a', type: 'test.record', params: {} },
      { id: 'b', type: 'test.record', params: {} },
    ];
    expect(
      messages(
        doc(nodes, [
          edge('s', 'then', 'a', 'exec'),
          edge('a', 'then', 'b', 'exec'),
          edge('b', 'then', 'a', 'exec'),
        ]),
      ),
    ).toEqual([]);
    expect(
      messages(
        doc(nodes, [
          edge('s', 'then', 'a', 'exec'),
          edge('s', 'then', 'b', 'exec'),
        ]),
      ),
    ).toEqual([
      'error: #s.then: edge s.then → b.exec: output "then" can only feed one edge',
    ]);
  });

  it('refuses a loop of values, and the flow into a value', () => {
    expect(
      messages(
        doc(
          [
            { id: 'a', type: 'math.add', params: {} },
            { id: 'b', type: 'math.add', params: {} },
            { id: 's', type: 'event.start', params: {} },
            { id: 'r', type: 'test.record', params: {} },
          ],
          [
            edge('a', 'value', 'b', 'a'),
            edge('b', 'value', 'a', 'a'),
            edge('s', 'then', 'r', 'value'),
            edge('s', 'then', 'r', 'exec'),
          ],
        ),
      ),
    ).toEqual([
      'error: #r.value: expected any, got exec from #s.then',
      'error: the graph has a cycle involving nodes #a, #b',
    ]);
  });

  it('checks the variables, the events and the switches', () => {
    expect(
      messages(
        doc(
          [
            { id: 'u', type: 'event.update', params: {} },
            {
              id: 'g',
              type: 'var.get',
              params: { name: 'hp', type: 'string' },
            },
            {
              id: 's',
              type: 'var.set',
              params: { name: 'nope', type: 'number' },
              defaults: { value: 1 },
            },
            {
              id: 'w',
              type: 'flow.switch',
              params: { cases: ['a', 'a', 'default'] },
              defaults: { value: 'a' },
            },
            { id: 'o', type: 'event.on', params: { event: 'update' } },
            {
              id: 'e',
              type: 'event.emit',
              params: {
                event: 'hit',
                fields: [
                  { name: 'then', type: 'number' },
                  { name: 'x', type: 'colour' },
                ],
              },
            },
          ],
          [
            edge('u', 'then', 's', 'exec'),
            edge('s', 'then', 'w', 'exec'),
            edge('w', 'a', 'e', 'exec'),
          ],
          [
            { name: 'hp', type: 'number', default: 'full' },
            { name: 'hp', type: 'number' },
          ],
        ),
      ),
    ).toEqual([
      'error: variable "hp" is a number, its default is "full"',
      'error: variable "hp" is declared twice',
      'error: #g: variable "hp" is a number, used as a string',
      'error: #s: unknown variable "nope"',
      'error: #w: case "a" is given twice',
      'error: #w: "default" cannot name a case',
      'error: #o: "update" cannot name an event of the graph',
      'error: #e: field "then" cannot be used here',
      'error: #e: field "x" has an unknown type "colour"',
      'warning: #e: no event.on node handles "hit"',
    ]);
  });

  it('round-trips through JSON', () => {
    const g = builder();
    g.variable('count', 'number', 1);
    g.set(g.onStart().then, 'count', g.add(g.get('count'), 1));
    const graph = g.build();
    expect(parseBehaviorGraph(serializeBehaviorGraph(graph))).toEqual(graph);
    expect(() =>
      parseBehaviorGraph({ ...graph, variables: [{ name: 1 }] }),
    ).toThrow('Malformed "variables"');
  });
});

describe('BehaviorGraphBuilder', () => {
  it('throws the errors of the graph, located', () => {
    const g = builder();
    g.variable('hp', 'number');
    g.set(g.onStart().then, 'hp', g.constant('lots'), { id: 'set' });
    expect(() => g.build()).toThrow(GraphError);
    expect(() => g.build()).toThrow(
      'error: #set.value: expected number, got string from #n2.value',
    );
  });

  it('refuses unknown variables, events, ports and ids', () => {
    const g = builder();
    expect(() => g.get('hp')).toThrow('Unknown variable "hp"');
    expect(() => g.on('hit')).toThrow('Unknown event "hit"');
    const start = g.onStart({ id: 'start' });
    expect(() => start.exec('true')).toThrow(
      'Node "start" has no exec output "true"',
    );
    expect(() => start.value()).toThrow(
      'Node "start" has no data output "value"',
    );
    expect(() => g.onStart({ id: 'start' })).toThrow(
      'Node id "start" is already used',
    );
  });
});

describe.each<BehaviorMode>(['interpret', 'compile'])(
  'running (%s)',
  (mode) => {
    it('starts once, then updates at each run', () => {
      const g = builder();
      g.variable('time', 'number');
      recordNode(g, g.onStart().then, 'start');
      const update = g.onUpdate();
      const set = g.set(
        update.then,
        'time',
        g.add(g.get('time'), update.value('dt')),
      );
      recordNode(g, set.then, 't=', set.value());
      const { system, host } = run(g.build(), mode);
      expect(system.mode).toBe(mode);
      const instance = system.attach(7);
      system.run(0.5);
      system.run(0.25);
      expect(host.calls).toEqual(['start', 't=0.5', 't=0.75']);
      expect(instance.get('time')).toBe(0.75);
      expect(instance.time).toBe(0.75);
    });

    it('branches, sequences, switches', () => {
      const g = builder();
      g.variable('state', 'string', 'b');
      const update = g.onUpdate();
      const seq = g.sequence(update.then, 3);
      const branch = g.branch(seq.exec('then0'), g.compare(1, '<', 2));
      recordNode(g, branch.exec('true'), 'yes');
      recordNode(g, branch.exec('false'), 'no');
      const sw = g.switch(seq.exec('then1'), g.get('state'), ['a', 'b']);
      recordNode(g, sw.exec('a'), 'a');
      recordNode(g, sw.exec('b'), 'b');
      const other = recordNode(g, sw.exec('default'), 'other');
      const set = g.set(seq.exec('then2'), 'state', 'z');
      g.link(set.then, other);
      const { system, host } = run(g.build(), mode);
      system.attach(0);
      system.run(0.1);
      system.run(0.1);
      expect(host.calls).toEqual([
        'yes',
        'b',
        'other',
        'yes',
        'other',
        'other',
      ]);
    });

    it('does once until reset, loops, and follows the exits of an action', () => {
      const g = builder();
      g.variable('sum', 'number');
      const update = g.onUpdate();
      const seq = g.sequence(update.then, 3);
      const once = g.doOnce(seq.exec('then0'));
      recordNode(g, once.then, 'once');
      const loop = g.forLoop(seq.exec('then1'), 1, 4);
      g.set(loop.exec('body'), 'sum', g.add(g.get('sum'), loop.value('index')));
      const r = g.node('test.roll', {
        from: loop.exec('completed'),
        inputs: { value: g.get('sum') },
      });
      recordNode(g, r.exec('low'), 'low');
      const high = recordNode(g, r.exec('high'), 'high ', r.value('half'));
      // The second update resets the doOnce.
      const reset = g.compare(g.get('sum'), '>', 15);
      const check = g.branch(seq.exec('then2'), reset);
      g.link(check.exec('true'), once, 'reset');
      void high;
      const { system, host } = run(g.build(), mode);
      const instance = system.attach(0);
      system.run(0.1);
      expect(instance.get('sum')).toBe(10);
      system.run(0.1);
      system.run(0.1);
      expect(host.calls).toEqual([
        'once',
        'high 5',
        'high 10',
        'once',
        'high 15',
      ]);
    });

    it('waits in delays, which ignore being reached again', () => {
      const g = builder();
      const tick = recordNode(g, g.onUpdate().then, 'tick');
      // Reached at every update; goes on once per 0.25 s at most.
      const delay = g.delay(tick.then, 0.25);
      recordNode(g, delay.then, 'done at ', g.now());
      const { system, host } = run(g.build(), mode);
      system.attach(0);
      for (let i = 0; i < 6; i++) system.run(0.125);
      expect(host.calls.filter((c) => c !== 'tick')).toEqual([
        'done at 0.375',
        'done at 0.625',
      ]);
    });

    it('evaluates a pure node once per node that reads it', () => {
      const g = builder();
      const update = g.onUpdate();
      const read = g.node('test.counter').value();
      const twice = g.add(read, read);
      const a = recordNode(g, update.then, 'a', twice);
      recordNode(g, a.then, 'b', read);
      const { system, host } = run(g.build(), mode);
      system.attach(0);
      system.run(0.1);
      // 1 + 1 for a, then 2 for b.
      expect(host.calls).toEqual(['a2', 'b2']);
      expect(host.reads).toBe(2);
    });

    it('handles the events of the application and of the graphs', () => {
      const g = builder();
      g.event('hit', { damage: 'number' });
      g.event('echo', { text: 'string' });
      g.variable('health', 'number', 100);
      const hit = g.on('hit');
      const set = g.set(
        hit.then,
        'health',
        g.sub(g.get('health'), hit.value('damage')),
      );
      const emitted = g.emit(set.then, 'echo', { text: 'ouch' }, 2);
      recordNode(g, emitted.then, 'hit ', g.self());
      const echo = g.on('echo');
      recordNode(g, echo.then, 'echo ', g.self());
      const { system, host } = run(g.build(), mode);
      const one = system.attach(1);
      system.attach(2);
      system.emit(1, 'hit', { damage: 30 });
      // The echo of #2 comes once the chain of #1 is over.
      expect(host.calls).toEqual(['hit 1', 'echo 2']);
      expect(one.get('health')).toBe(70);
      system.emit(9, 'hit', { damage: 1 });
      expect(host.calls).toHaveLength(2);
    });

    it('stops a flow that loops forever', () => {
      const g = builder();
      const a = recordNode(g, g.onUpdate().then, 'a', undefined, 'a');
      g.link(a.then, a);
      const { system } = run(g.build(), mode, { maxSteps: 50 });
      system.attach(3);
      expect(() => system.run(0.1)).toThrow(BehaviorError);
      expect(() => system.run(0.1)).toThrow(
        'Behavior graph "test": more than 50 nodes in a chain',
      );
    });

    it('starts afresh after a node threw', () => {
      const g = builder();
      g.event('go');
      const go = g.on('go');
      const seq = g.sequence(go.then, 2);
      g.node('test.wrong', { from: seq.exec('then0') });
      recordNode(g, seq.exec('then1'), 'second');
      const ok = recordNode(g, g.onUpdate().then, 'update');
      void ok;
      const { system, host } = run(g.build(), mode);
      system.attach(0);
      expect(() => system.emit(0, 'go')).toThrow('returned the exit "nope"');
      // The rest of the broken chain does not run with the next event.
      system.run(0.1);
      expect(host.calls).toEqual(['update']);
    });

    it('reports an action going out by an exit it lacks', () => {
      const g = builder();
      g.node('test.wrong', { from: g.onStart().then }, { id: 'w' });
      const { system } = run(g.build(), mode);
      system.attach(0);
      expect(() => system.run(0)).toThrow(
        'Node type "test.wrong" returned the exit "nope", which it does not have',
      );
    });

    it('stops the chain of an instance detached by its own action', () => {
      const g = builder();
      const gone = g.node('test.vanish', { from: g.onUpdate().then });
      recordNode(g, gone.then, 'after');
      const { system, host } = run(g.build(), mode);
      host.remove = (entity) => system.detach(entity);
      system.attach(0);
      system.attach(1);
      system.run(0.1);
      expect(host.calls).toEqual([]);
      expect(system.size).toBe(0);
    });

    it('draws from the random source, logs, and takes variables', () => {
      const g = builder();
      g.variable('kind', 'string', 'orc');
      const update = g.onUpdate();
      const logged = g.log(update.then, 'roll', g.random(10, 20));
      g.log(logged.then, 'kind', g.get('kind'));
      const { system, logs } = run(g.build(), mode, { random: () => 0.5 });
      system.attach(0, { kind: 'demon' });
      system.run(0.1);
      expect(logs).toEqual(['roll 15', 'kind demon']);
      expect(() => system.attach(0)).toThrow('Entity 0 runs "test" already');
      expect(() => system.attach(1, { kind: 3 })).toThrow(
        'Variable "kind" is a string, not 3',
      );
    });
  },
);

describe('BehaviorSystem', () => {
  const delayed = () => {
    const g = builder();
    const delay = g.delay(g.onStart().then, 0.3);
    recordNode(g, delay.then, 'woke');
    return g.build();
  };

  it('keeps the delays when switching modes', () => {
    const { system, host } = run(delayed(), 'interpret');
    system.attach(0);
    system.run(0.2);
    system.mode = 'compile';
    expect(system.mode).toBe('compile');
    system.run(0.2);
    expect(host.calls).toEqual(['woke']);
  });

  it('installs itself in a scheduler', () => {
    const added: { name: string; phase?: string; after?: readonly string[] }[] =
      [];
    let removed = '';
    const runs: ((dt: number) => void)[] = [];
    const scheduler = {
      add: (
        name: string,
        system: (dt: number) => void,
        options: { phase?: string; after?: readonly string[] } = {},
      ) => {
        added.push({ name, ...options });
        runs.push(system);
      },
      remove: (name: string) => {
        removed = name;
        return true;
      },
    };
    const { system, host } = run(delayed(), 'compile');
    system.attach(0);
    const uninstall = system.install(scheduler, { after: ['physics'] });
    expect(added).toEqual([
      { name: 'test', phase: 'fixed', after: ['physics'] },
    ]);
    runs[0](0.5);
    runs[0](0.1);
    expect(host.calls).toEqual(['woke']);
    uninstall();
    expect(removed).toBe('test');
  });

  it('compiles names and constants as strings, never as code', () => {
    const g = builder('"); throw 1; ("');
    const name = '"]; throw new Error("injected"); ["';
    g.variable(name, 'string', name);
    recordNode(g, g.onStart().then, name, g.get(name));
    const { system, host } = run(g.build(), 'compile');
    expect(system.compiled?.source).toContain(JSON.stringify(name));
    system.attach(0);
    system.run(0);
    expect(host.calls).toEqual([name + name]);
  });
});

describe('BehaviorGraphType', () => {
  it('loads the graphs of their files through a store', async () => {
    const g = builder('guard');
    g.variable('health', 'number', 100);
    const graph = g.build();
    const store = new ResourceStore();
    store.mount(
      'mem',
      new MemorySource({
        'guard.behavior.json': serializeBehaviorGraph(graph),
      }),
      { default: true },
    );
    store.registerLoader(behaviorGraphLoader);
    expect(
      await store.load(BehaviorGraphType, 'guard.behavior.json').ready,
    ).toEqual(graph);
  });
});

describe('behaviorCodec', () => {
  it('saves the entities a graph runs for, and their variables', async () => {
    const g = builder('guard');
    g.variable('health', 'number', 100);
    g.variable('target', 'entity');
    recordNode(g, g.onStart().then, 'start');
    const graph = g.build();
    const scene = new Scene();
    const guard = scene.root.add({ name: 'guard' });
    const door = scene.root.add({ name: 'door' });
    const { system } = run(graph, 'interpret');
    system.attach(guard.entity, { health: 40, target: door.entity });
    const data = captureScene(scene, { codecs: [behaviorCodec([system])] });
    const doorIndex = data.nodes.findIndex((n) => n.name === 'door');
    expect(data.nodes.find((n) => n.name === 'guard')!.components).toEqual({
      behavior: {
        version: 1,
        data: [
          { graph: 'guard', variables: { health: 40, target: doorIndex } },
        ],
      },
    });
    const other = new Scene();
    const again = run(graph, 'interpret').system;
    const instance = await instantiateScene(data, other, {
      store: new ResourceStore(),
      codecs: [behaviorCodec({ guard: again })],
    });
    const entity = other.find('guard')!.entity;
    expect(again.instance(entity)?.variables).toEqual({
      health: 40,
      target: instance.entities[doorIndex],
    });
  });
});

describe('BehaviorDebugger', () => {
  // Counts at each update; from 2 on, the branch goes on.
  const counting = () => {
    const g = builder();
    g.variable('count', 'number');
    const update = g.onUpdate({ id: 'update' });
    const set = g.set(update.then, 'count', g.add(g.get('count'), 1), {
      id: 'count',
    });
    const big = g.compare(set.value(), '>=', 2);
    const branch = g.branch(set.then, big, { id: 'branch' });
    recordNode(g, branch.exec('true'), 'big', undefined, 'big');
    return g.build();
  };

  it('interprets while open, then takes the mode set meanwhile', () => {
    const { system } = run(counting(), 'compile');
    let debug = system.debug();
    expect(system.mode).toBe('interpret');
    debug.close();
    expect(system.mode).toBe('compile');
    system.mode = 'interpret';
    debug = system.debug();
    system.mode = 'compile';
    expect(system.mode).toBe('interpret');
    debug.close();
    expect(system.mode).toBe('compile');
  });

  it('stops at a breakpoint, shows the states, steps and continues', () => {
    const { system, host } = run(counting(), 'compile');
    system.attach(4);
    const debug = system.debug();
    const pauses: string[] = [];
    debug.onPause(({ node, reason, instance }) =>
      pauses.push(`${reason} ${node} #${instance.entity}`),
    );
    debug.addBreakpoint('branch');
    system.run(0.1);
    expect(pauses).toEqual(['breakpoint branch #4']);
    expect(debug.paused?.node).toBe('branch');
    expect(debug.trace(4)).toEqual(['update', 'count']);
    const count = debug.state(4, 'count');
    expect(count).toMatchObject({
      runs: 1,
      outputs: { value: 1 },
      active: true,
      breakpoint: false,
    });
    // Paused: the system does not run.
    system.run(0.1);
    expect(system.instance(4)?.get('count')).toBe(1);

    // 1 < 2: the branch goes nowhere, the chain ends.
    debug.step();
    expect(debug.paused).toBeUndefined();
    // The step stops before the next node to run: the next update.
    system.run(0.1);
    expect(pauses.at(-1)).toBe('step update #4');
    debug.step();
    expect(pauses.at(-1)).toBe('step count #4');
    debug.continue();
    expect(pauses.at(-1)).toBe('breakpoint branch #4');
    debug.continue();
    expect(host.calls).toEqual(['big']);
    expect(debug.trace(4)).toEqual(['update', 'count', 'branch', 'big']);
  });

  it('stops the instance of its entity only, and queues events while paused', () => {
    const g = builder();
    g.event('ping');
    const update = g.onUpdate({ id: 'update' });
    recordNode(g, update.then, 'u', g.self(), 'u');
    recordNode(g, g.on('ping', { id: 'ping' }).then, 'p', g.self());
    const { system, host } = run(g.build(), 'interpret');
    system.attach(1);
    system.attach(2);
    const debug = system.debug();
    debug.entity = 2;
    debug.addBreakpoint('u');
    system.run(0.1);
    expect(host.calls).toEqual(['u1']);
    system.emit(1, 'ping');
    expect(host.calls).toEqual(['u1']);
    debug.continue();
    expect(host.calls).toEqual(['u1', 'u2', 'p1']);
    expect(() => debug.addBreakpoint('nope')).toThrow('No node "nope"');
    const pure = system.program.nodes.find((n) => n.kind === 'pure');
    expect(() => debug.addBreakpoint(pure?.id ?? '')).toThrow('is pure');
  });

  it('forgets a paused instance that is detached', () => {
    const { system } = run(counting(), 'interpret');
    system.attach(0);
    const debug = system.debug();
    debug.addBreakpoint('count');
    system.run(0.1);
    expect(debug.paused).toBeDefined();
    system.detach(0);
    expect(debug.paused).toBeUndefined();
    expect(debug.toggleBreakpoint('count')).toBe(false);
    expect(debug.breakpoints.size).toBe(0);
  });
});
