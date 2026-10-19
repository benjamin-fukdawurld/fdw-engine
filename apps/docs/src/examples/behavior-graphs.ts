import {
  actionNode,
  type BehaviorDebugger,
  BehaviorGraphBuilder,
  BehaviorSystem,
  createBehaviorRegistry,
  pureNode,
  type Vec3,
} from '@fdw/engine-behavior';
import { Camera, DirectionalLight, Material, Renderer } from '@fdw/engine-core';
import { ActionMap, Input } from '@fdw/engine-input';
import { WebInputSource } from '@fdw/engine-input-web';
import { Scene, Scheduler } from '@fdw/engine-scene';
import { BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import {
  axisAngle,
  createCapsule,
  createCube,
  createSphere,
} from '@fdw/demo-scenes';
import type { Example } from './runtime';

// Four guards patrol an arena, each around its own square. A behavior
// graph decides what each one does: patrol, chase the intruder it sees,
// search where it lost it or where a noise came from. The intruder walks
// a loop; click the canvas to take it over with W A S D, H makes a noise.
// The keys of the debugger: B a breakpoint where a guard spots the
// intruder, N one node, C continue, 1 to 4 the guard watched; M switches
// between the interpreter and the compiled graph.
const example: Example = ({ backend, surface, canvas, onFrame, info }) => {
  canvas.addEventListener('pointerdown', () => canvas.focus());

  // --- The game: what the nodes of the graph read and do -----------------
  interface Guards {
    // The guards, by entity.
    readonly positions: Map<number, { x: number; y: number; z: number }>;
    readonly routes: Map<number, readonly Vec3[]>;
    readonly intruder: { x: number; y: number; z: number };
  }

  const position = pureNode<Guards>({
    id: 'guard.position',
    output: 'vec3',
    evaluate: (call) => call.self.host.positions.get(call.self.entity),
  });
  const intruder = pureNode<Guards>({
    id: 'guard.intruder',
    output: 'vec3',
    evaluate: (call) => call.self.host.intruder,
  });
  const waypoint = pureNode<Guards>({
    id: 'guard.waypoint',
    inputs: { index: 'number' },
    output: 'vec3',
    evaluate: (call, index: number) => {
      const route = call.self.host.routes.get(call.self.entity) ?? [];
      return route[index % route.length];
    },
  });
  // Walks towards a point for a step: `moving`, or `arrived` once there.
  const moveTo = actionNode<Guards>({
    id: 'guard.moveTo',
    inputs: { target: 'vec3', speed: 'number', dt: 'number' },
    exits: ['moving', 'arrived'],
    run: (call, target: Vec3, speed: number, dt: number) => {
      const p = call.self.host.positions.get(call.self.entity);
      if (!p) return 'arrived';
      const dx = target.x - p.x;
      const dz = target.z - p.z;
      const distance = Math.hypot(dx, dz);
      const reach = speed * dt;
      if (distance <= reach) {
        p.x = target.x;
        p.z = target.z;
        return 'arrived';
      }
      p.x += (dx / distance) * reach;
      p.z += (dz / distance) * reach;
      return 'moving';
    },
  });
  const registry = createBehaviorRegistry([
    position,
    intruder,
    waypoint,
    moveTo,
  ]);

  // --- The graph of a guard ---------------------------------------------
  const g = new BehaviorGraphBuilder('guard', registry);
  g.variable('state', 'string', 'patrol');
  g.variable('waypoint', 'number', 0);
  // Where it searches.
  g.variable('target', 'vec3');
  g.event('noise', { at: 'vec3' });

  const me = g.node('guard.position').value();
  const thief = g.node('guard.intruder').value();
  const distance = g.distance(me, thief);
  const sees = g.compare(distance, '<', 3.5);

  const update = g.onUpdate({ id: 'update', label: 'update' });
  const dt = update.value('dt');
  const state = g.get('state');
  const decide = g.switch(update.then, state, ['patrol', 'chase', 'search'], {
    id: 'decide',
    label: 'decide',
  });

  // Patrol: from waypoint to waypoint, until it sees the intruder.
  const watch = g.branch(decide.exec('patrol'), sees, { label: 'sees?' });
  g.set(watch.exec('true'), 'state', 'chase', { id: 'spot', label: 'spot' });
  const index = g.get('waypoint');
  const walk = g.node(
    'guard.moveTo',
    {
      from: watch.exec('false'),
      inputs: {
        target: g.node('guard.waypoint', { inputs: { index } }).value(),
        speed: 1.6,
        dt,
      },
    },
    { label: 'walk' },
  );
  g.set(
    walk.exec('arrived'),
    'waypoint',
    g.select(g.compare(index, '>=', 3), 0, g.add(index, 1)),
    { label: 'next waypoint' },
  );

  // Chase: runs after the intruder; too far, searches where it was.
  const lost = g.branch(decide.exec('chase'), g.compare(distance, '>', 6), {
    label: 'lost?',
  });
  const lastSeen = g.set(lost.exec('true'), 'target', thief, {
    label: 'last seen',
  });
  g.set(lastSeen.then, 'state', 'search', { label: 'search' });
  g.node(
    'guard.moveTo',
    { from: lost.exec('false'), inputs: { target: thief, speed: 3.2, dt } },
    { label: 'run' },
  );

  // Search: goes there, waits two seconds, back to its patrol.
  const look = g.branch(decide.exec('search'), sees, { label: 'sees?' });
  g.set(look.exec('true'), 'state', 'chase', { label: 'spot again' });
  const go = g.node(
    'guard.moveTo',
    {
      from: look.exec('false'),
      inputs: { target: g.get('target'), speed: 2.2, dt },
    },
    { label: 'go there' },
  );
  const wait = g.delay(go.exec('arrived'), 2, { label: 'wait 2 s' });
  const still = g.branch(wait.then, g.equals(g.get('state'), 'search'), {
    label: 'still searching?',
  });
  g.set(still.exec('true'), 'state', 'patrol', { label: 'patrol' });

  // A noise: a guard on patrol goes to see.
  const noise = g.on('noise', { label: 'noise' });
  const calm = g.branch(noise.then, g.equals(state, 'patrol'), {
    label: 'on patrol?',
  });
  const there = g.set(calm.exec('true'), 'target', noise.value('at'), {
    label: 'there',
  });
  g.set(there.then, 'state', 'search', { label: 'search' });

  const graph = g.build();

  // --- The scene ----------------------------------------------------------
  const sg = new GraphBuilder('lit');
  sg.surface({
    shadingModel: 'pbr',
    baseColor: sg.uniform('color', BuiltinTypes.vec3f),
    roughness: 0.6,
  });
  const lit = sg.build();
  const material = (color: [number, number, number]) =>
    new Material({ graph: lit, values: { color } });
  const scene = new Scene();
  scene.root
    .add({
      position: { y: -0.25 },
      scale: { x: 18, y: 0.5, z: 14 },
      static: true,
    })
    .setMesh(createCube(), material([0.42, 0.44, 0.46]));
  scene.root.add({ rotation: axisAngle(1, 0.2, 0.1, -1.05) }).setLight(
    new DirectionalLight({
      castShadow: true,
      diffuse: { x: 1.2, y: 1.15, z: 1.05 },
      ambient: { x: 0.18, y: 0.19, z: 0.24 },
    }),
  );

  const colors: Record<string, [number, number, number]> = {
    patrol: [0.25, 0.6, 0.35],
    chase: [0.9, 0.25, 0.2],
    search: [0.95, 0.65, 0.15],
  };
  const host: Guards = {
    positions: new Map(),
    routes: new Map(),
    intruder: { x: 0, y: 0, z: 0 },
  };
  const tile = createCube();
  const marker = material([0.32, 0.34, 0.37]);
  const body = createCapsule(0.35, 0.3);
  const guards: {
    entity: number;
    node: ReturnType<typeof scene.root.add>;
    material: Material;
  }[] = [];
  // Four squares, one per quarter of the arena.
  for (const [cx, cz] of [
    [-4.5, -3],
    [4.5, -3],
    [-4.5, 3],
    [4.5, 3],
  ]) {
    const route = [
      { x: cx - 2, y: 0, z: cz - 1.5 },
      { x: cx + 2, y: 0, z: cz - 1.5 },
      { x: cx + 2, y: 0, z: cz + 1.5 },
      { x: cx - 2, y: 0, z: cz + 1.5 },
    ];
    for (const point of route) {
      scene.root
        .add({
          position: { x: point.x, y: 0.01, z: point.z },
          scale: { x: 0.5, y: 0.02, z: 0.5 },
          static: true,
        })
        .setMesh(tile, marker);
    }
    const look = material(colors['patrol']);
    const node = scene.root.add().setMesh(body, look);
    host.positions.set(node.entity, { ...route[0] });
    host.routes.set(node.entity, route);
    guards.push({ entity: node.entity, node, material: look });
  }
  const thiefNode = scene.root
    .add({ scale: { x: 0.5, y: 0.5, z: 0.5 } })
    .setMesh(createSphere(24, 12), material([0.95, 0.85, 0.2]));

  const camera = new Camera({
    projection: {
      type: 'perspective',
      fov: 50,
      aspect: 16 / 9,
      near: 0.1,
      far: 100,
    },
  });
  scene.root
    .add({ position: { y: 13, z: 12.5 }, rotation: axisAngle(1, 0, 0, -0.8) })
    .setCamera(camera);
  const renderer = new Renderer(backend, {
    output: { toneMapping: 'neutral', encoding: 'srgb' },
  });

  // --- The graph as a system ---------------------------------------------
  const guardsSystem = new BehaviorSystem(graph, { host, registry });
  for (const { entity } of guards) {
    guardsSystem.attach(entity);
  }
  const scheduler = new Scheduler();

  const input = new Input(new WebInputSource(canvas));
  const button = (code: string) => ({
    type: 'button' as const,
    bindings: [`key:${code}`],
  });
  const actions = new ActionMap(input, {
    move: {
      type: 'vector',
      bindings: [
        {
          up: 'key:KeyW',
          down: 'key:KeyS',
          left: 'key:KeyA',
          right: 'key:KeyD',
        },
      ],
    },
    noise: button('KeyH'),
    breakpoint: button('KeyB'),
    step: button('KeyN'),
    continue: button('KeyC'),
    mode: button('KeyM'),
    guard1: button('Digit1'),
    guard2: button('Digit2'),
    guard3: button('Digit3'),
    guard4: button('Digit4'),
  });
  let manual = false;
  let watched = 0;

  // The debugger, opened by the first key that needs it: the graph is
  // interpreted while it is open. While the graph is stopped, the fixed
  // step stops: the intruder waits too.
  let debugger_: BehaviorDebugger<Guards> | undefined;
  const debug = () => {
    if (!debugger_) {
      debugger_ = guardsSystem.debug();
      debugger_.onPause(() => (scheduler.paused = true));
    }
    debugger_.entity = guards[watched].entity;
    return debugger_;
  };
  const resumed = () => {
    scheduler.paused = debugger_?.paused !== undefined;
  };

  // begin: the keys.
  scheduler.add(
    'input',
    () => {
      input.update();
      for (let i = 0; i < 4; i++) {
        if (actions.button(`guard${i + 1}`).pressed) {
          watched = i;
          if (debugger_) debug();
        }
      }
      if (actions.button('noise').pressed) {
        for (const { entity } of guards) {
          guardsSystem.emit(entity, 'noise', { at: { ...host.intruder } });
        }
      }
      if (actions.button('breakpoint').pressed) {
        debug().toggleBreakpoint('spot');
      }
      if (actions.button('step').pressed) {
        debug().step();
        resumed();
      }
      if (actions.button('continue').pressed && debugger_) {
        debugger_.continue();
        resumed();
      }
      if (actions.button('mode').pressed) {
        if (debugger_) {
          // Closed: no breakpoint, the graph compiled again.
          debugger_.close();
          debugger_ = undefined;
          scheduler.paused = false;
        } else {
          debug();
        }
      }
    },
    { phase: 'begin' },
  );

  // fixed: the intruder walks its loop (or goes where the keys say), then
  // the guards decide and move.
  scheduler.add(
    'intruder',
    (step) => {
      const move = actions.vector('move', { x: 0, y: 0 });
      if (move.x !== 0 || move.y !== 0) manual = true;
      if (manual) {
        host.intruder.x = Math.max(
          -8.5,
          Math.min(8.5, host.intruder.x + move.x * 3 * step),
        );
        host.intruder.z = Math.max(
          -6.5,
          Math.min(6.5, host.intruder.z - move.y * 3 * step),
        );
      } else {
        const t = scheduler.time;
        host.intruder.x = Math.sin(t * 0.3) * 7;
        host.intruder.z = Math.sin(t * 0.6) * 4.5;
      }
    },
    { phase: 'fixed' },
  );
  guardsSystem.install(scheduler, { name: 'guards', after: ['intruder'] });

  // update: the nodes where the guards and the intruder are; the colour
  // of each guard after its state.
  scheduler.add('draw', () => {
    for (const guard of guards) {
      const p = host.positions.get(guard.entity) ?? { x: 0, y: 0, z: 0 };
      guard.node.transform.position = { x: p.x, y: 0.65, z: p.z };
      const state = guardsSystem.instance(guard.entity)?.variables['state'];
      guard.material.setValue(
        'color',
        colors[state as string] ?? colors['patrol'],
      );
    }
    thiefNode.transform.position = {
      x: host.intruder.x,
      y: 0.25,
      z: host.intruder.z,
    };
  });

  // render: the view, and the state of the watched guard.
  scheduler.add(
    'render',
    () => {
      renderer.render({
        source: scene,
        camera,
        surface,
        clearColor: { r: 0.08, g: 0.09, b: 0.11, a: 1 },
      });
    },
    { phase: 'render' },
  );
  scheduler.add(
    'status',
    () => {
      const guard = guards[watched].entity;
      const state = guardsSystem.instance(guard)?.variables['state'];
      const parts = [
        guardsSystem.mode,
        `guard ${watched + 1}: ${String(state)}`,
      ];
      if (debugger_) {
        const { nodes, byId } = guardsSystem.program;
        const label = (id: string) => nodes[byId.get(id) ?? 0].label;
        if (debugger_.paused) {
          parts.push(`stopped before "${label(debugger_.paused.node)}"`);
        }
        parts.push(
          `breakpoint ${debugger_.breakpoints.size > 0 ? 'on' : 'off'}`,
          debugger_.trace(guard).map(label).join(' → ') || '…',
        );
      } else {
        parts.push('click, then W A S D, H, B, N, C, M, 1-4');
      }
      info(parts.join(' · '));
    },
    { phase: 'render', after: ['render'] },
  );

  let last = 0;
  onFrame((time) => {
    scheduler.update(time - last);
    last = time;
  });
};

export default example;
