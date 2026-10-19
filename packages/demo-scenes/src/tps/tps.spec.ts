import { FakeAudioEngine } from '@fdw/engine-audio';
import { fakeBackend, surface } from '@fdw/engine-core/testing';
import { FakeInputSource, Input } from '@fdw/engine-input';
import type {
  PhysicsCollider,
  PhysicsEngine,
  PhysicsWorld,
} from '@fdw/engine-physics';
import { ResourceStore, type ResourceSource } from '@fdw/engine-resources';
import { Scene } from '@fdw/engine-scene';
import { describe, expect, it } from 'vitest';
import { Blow, strikeCapsule, strikeSphere } from './combat';
import { tpsControls } from './controls';
import { BehaviorSystem } from '@fdw/engine-behavior';
import { type EnemyHost, enemyGraph, enemyRegistry } from './brain';
import { EnemyKinds, TrunkGrid } from './enemies';
import { forestHeights } from './forest';
import { HeroActions, heroClips, heroGraph } from './hero';
import { TpsSounds } from './sounds';
import { createTpsScene } from './tps';

// A world whose overlaps report the colliders given, and record the shapes
// asked.
const fakeWorld = (colliders: PhysicsCollider[]) => {
  const asked: {
    shape: { type: string; halfHeight?: number; radius?: number };
    position: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number; w: number };
  }[] = [];
  const world = {
    overlap: (
      shape: { type: string },
      position: { x: number; y: number; z: number },
      rotation: { x: number; y: number; z: number; w: number },
      visit: (collider: PhysicsCollider) => void,
      filter?: { predicate?: (collider: PhysicsCollider) => boolean },
    ) => {
      asked.push({ shape, position, rotation });
      for (const collider of colliders) {
        if (!filter?.predicate || filter.predicate(collider)) visit(collider);
      }
    },
  } as unknown as PhysicsWorld;
  return { world, asked };
};
const collider = (name: string) => ({ name }) as unknown as PhysicsCollider;

describe('forestHeights', () => {
  it('is flat in the clearing and rises past the play area', () => {
    const resolution = 64;
    const size = 512;
    const heights = forestHeights(resolution, {
      size,
      height: 40,
      playRadius: 100,
      seed: 7,
    });
    const at = (x: number, z: number) =>
      heights[
        Math.floor((z / size + 0.5) * resolution) * resolution +
          Math.floor((x / size + 0.5) * resolution)
      ];
    // The clearing: the base height, 10 % of the full height.
    expect(at(0, 0)).toBeCloseTo(0.1, 2);
    expect(at(4, -4)).toBeCloseTo(0.1, 2);
    // Past the play area, the rim.
    expect(at(200, 0)).toBeGreaterThan(0.7);
    expect(at(0, -200)).toBeGreaterThan(0.7);
    for (const height of heights) {
      expect(height).toBeGreaterThanOrEqual(0);
      expect(height).toBeLessThanOrEqual(1);
    }
  });
});

describe('TrunkGrid', () => {
  it('finds the trunks near a point, their radius counted', () => {
    const grid = new TrunkGrid(
      Float32Array.from([0, 0, 0.5, 3, 0, 0.5, 20, 20, 0.5, -9, 0, 0.5]),
    );
    const found: number[][] = [];
    grid.near(0.5, 0, 2.5, (x, z) => found.push([x, z]));
    expect(found.sort()).toEqual([
      [0, 0],
      [3, 0],
    ]);
    // Across the cells of the grid.
    found.length = 0;
    grid.near(-8, 0, 1, (x, z) => found.push([x, z]));
    expect(found).toEqual([[-9, 0]]);
  });
});

describe('blows', () => {
  it('strike each target once per blow', () => {
    const [orc, hero] = [collider('orc'), collider('hero')];
    const { world } = fakeWorld([orc, hero]);
    const blow = new Blow(20, (c) => c === orc);
    const from = { x: 0, y: 1, z: 0 };
    const to = { x: 0, y: 1, z: -1 };
    expect(strikeCapsule(world, blow, from, to, 0.1)).toEqual([
      { collider: orc, damage: 20, point: { x: 0, y: 1, z: -0.5 } },
    ]);
    expect(strikeCapsule(world, blow, from, to, 0.1)).toEqual([]);
    // A new blow strikes again.
    expect(
      strikeSphere(world, new Blow(5, (c) => c === hero), from, 0.5),
    ).toHaveLength(1);
  });

  it('lays the capsule along the blade', () => {
    const { world, asked } = fakeWorld([]);
    strikeCapsule(
      world,
      new Blow(1, () => true),
      { x: 0, y: 0, z: 0 },
      { x: 2, y: 0, z: 0 },
      0.1,
    );
    const [{ shape, position, rotation }] = asked;
    expect(shape).toMatchObject({
      type: 'capsule',
      halfHeight: 1,
      radius: 0.1,
    });
    expect(position).toEqual({ x: 1, y: 0, z: 0 });
    // +y turned to +x: a quarter turn around -z.
    const { x, y, z, w } = rotation;
    const turned = {
      x: 2 * (x * y - w * z),
      y: 1 - 2 * (x * x + z * z),
      z: 2 * (y * z + w * x),
    };
    expect(turned.x).toBeCloseTo(1);
    expect(turned.y).toBeCloseTo(0);
    expect(turned.z).toBeCloseTo(0);
  });
});

describe('the hero', () => {
  it('has a state of its graph for each action, entered by its number', () => {
    const graph = heroGraph();
    const machine = graph.nodes.find(
      (node) => node.type === 'anim.stateMachine',
    );
    const params = machine?.params as {
      transitions: {
        to: string;
        conditions: { parameter: string; value: number }[];
      }[];
    };
    expect(params.transitions.map((t) => t.to)).toEqual([...HeroActions]);
    params.transitions.forEach((t, i) =>
      expect(t.conditions).toEqual([{ parameter: 'action', value: i }]),
    );
  });

  it('strikes with its blade while the clips swing', () => {
    const clip = (name: string, duration: number) => ({
      name,
      duration,
      withEvents(events: { time: number; name: string }[]) {
        return { ...this, events };
      },
    });
    const names = [
      'Walk',
      'Jog',
      'Sprint',
      'AttackA',
      'AttackB',
      'AttackC',
      'HeavyAttack',
    ];
    const clips = Object.fromEntries(names.map((n) => [n, clip(n, 1)]));
    const out = heroClips(clips as never) as unknown as Record<
      string,
      { events: { time: number; name: string }[] }
    >;
    expect(out['Walk'].events.map((e) => e.name)).toEqual(['step', 'step']);
    const rounded = (events: { time: number; name: string }[]) =>
      events.map(({ time, name }) => ({
        time: Math.round(time * 1000) / 1000,
        name,
      }));
    expect(rounded(out['AttackA'].events)).toEqual([
      { time: 0.1, name: 'swing' },
      { time: 0.15, name: 'strike' },
      { time: 0.32, name: 'strikeEnd' },
    ]);
    // Two blows in the third strike.
    expect(
      out['AttackC'].events.filter((e) => e.name === 'strike'),
    ).toHaveLength(2);
  });
});

describe('tpsControls', () => {
  it('starts in the menu, the camera turned by the locked pointer only', () => {
    const { game, menu } = tpsControls(new Input(new FakeInputSource()));
    expect(game.enabled).toBe(false);
    expect(menu.enabled).toBe(true);
    const bindings = game.toJSON();
    expect(bindings['drag']).toEqual(['pointer:locked']);
    expect(bindings['heavy']).toContain('pointer:2');
    expect(bindings['roll']).toContain('key:KeyC');
  });
});

describe('the enemies', () => {
  it('have the demon stronger, slower and harder to stop than the orcs', () => {
    const { orc, demon } = EnemyKinds;
    expect(demon.health).toBeGreaterThan(orc.health * 3);
    expect(demon.run).toBeLessThan(orc.run);
    expect(demon.poise).toBeGreaterThan(orc.poise);
    expect(demon.reach).toBeGreaterThan(orc.reach);
  });
});

describe('enemyGraph', () => {
  // A game reduced to what the graph asks: distances given, the calls
  // recorded.
  const game = (distance: number) => {
    const calls: string[] = [];
    const host: EnemyHost & { distance: number; alive: boolean } = {
      maxAttackers: 2,
      distance,
      alive: true,
      get heroAlive() {
        return this.alive;
      },
      attackers: () =>
        [...system.instances].filter((i) => i.variables['state'] === 'attack')
          .length,
      heroDistance: () => host.distance,
      startAttack: (e) => calls.push(`attack ${e}`),
      swing: (e) => calls.push(`swing ${e}`),
      strike: (e) => calls.push(`strike ${e}`),
      steer: () => undefined,
      hurt: (e) => calls.push(`hurt ${e}`),
      die: (e) => calls.push(`die ${e}`),
      sink: () => undefined,
      remove: (e) => {
        calls.push(`remove ${e}`);
        system.detach(e);
      },
    };
    const system: BehaviorSystem<EnemyHost> = new BehaviorSystem(enemyGraph(), {
      host,
      registry: enemyRegistry,
      random: () => 0.5,
    });
    const steps = (seconds: number) => {
      for (let t = 0; t < seconds - 1e-9; t += 0.05) system.run(0.05);
    };
    return { system, host, calls, steps };
  };
  const orc = {
    health: 60,
    cooldown: 0,
    reach: 1.9,
    poise: 0,
    rest: 1.3,
    strikeStart: 0.3,
    strikeEnd: 0.45,
    attackLength: 1,
  };

  it.each(['compile', 'interpret'] as const)(
    'roars, chases, strikes in the window of its blow, recovers (%s)',
    (mode) => {
      const { system, host, calls, steps } = game(10);
      system.mode = mode;
      const enemy = system.attach(1, orc);
      steps(0.5);
      expect(enemy.get('state')).toBe('spawn');
      steps(0.5);
      expect(enemy.get('state')).toBe('chase');
      // Within reach.
      host.distance = 1;
      steps(0.05);
      expect(enemy.get('state')).toBe('attack');
      steps(1);
      expect(calls[0]).toBe('attack 1');
      expect(calls.filter((c) => c === 'swing 1')).toHaveLength(1);
      // Struck at each step of the window: 0.3 to 0.45 s.
      expect(calls.filter((c) => c === 'strike 1').length).toBeGreaterThan(1);
      expect(enemy.get('state')).toBe('recover');
      expect(enemy.get('cooldown')).toBeCloseTo(1.3, 1);
    },
  );

  it('lets two strike at once, the others wait', () => {
    const { system, steps } = game(1);
    for (let e = 1; e <= 3; e++) system.attach(e, orc);
    steps(0.9);
    const states = [...system.instances].map((i) => i.variables['state']);
    expect(states.filter((s) => s === 'attack')).toHaveLength(2);
    expect(states.filter((s) => s === 'chase')).toHaveLength(1);
  });

  it('staggers when the blow beats its poise, falls, sinks, and is gone', () => {
    const { system, calls, steps } = game(10);
    const demon = system.attach(1, { ...orc, health: 320, poise: 50 });
    const weak = system.attach(2, orc);
    steps(1);
    system.emit(1, 'hit', { damage: 20 });
    system.emit(2, 'hit', { damage: 20 });
    expect(demon.get('health')).toBe(300);
    expect(demon.get('state')).toBe('chase');
    expect(weak.get('state')).toBe('hurt');
    expect(calls).toEqual(['hurt 1', 'hurt 2']);
    system.emit(2, 'hit', { damage: 50 });
    expect(weak.get('state')).toBe('dead');
    // A fallen enemy takes no more blows.
    system.emit(2, 'hit', { damage: 50 });
    expect(weak.get('health')).toBe(-10);
    steps(4.1);
    expect(calls.slice(2)).toEqual(['die 2', 'remove 2']);
    expect(system.instance(2)).toBeUndefined();
  });
});

describe('TpsSounds', () => {
  it('plays the blows and the steps, the forest then the fight', () => {
    const audio = new FakeAudioEngine();
    const scene = new Scene();
    const sounds = new TpsSounds(scene, audio, scene.root.add());
    sounds.fight(false);
    sounds.hero.step?.();
    sounds.hero.swing?.(false);
    sounds.hero.blocked?.();
    sounds.enemies.death?.({ x: 3, y: 0, z: 0 }, EnemyKinds.orc);
    sounds.fight(true);
    audio.advance(0.1);
    const played = audio.played;
    // The steps, the swing and the parry where the hero is; the death of
    // the orc where it fell.
    expect(
      played.filter((voice) => !voice.spatial && !voice.loop),
    ).toHaveLength(3);
    expect(played.filter((voice) => voice.spatial)).toHaveLength(2);
    // The forest, then the fight: two loops.
    expect(played.filter((voice) => voice.loop)).toHaveLength(2);
    sounds.destroy();
  });
});

describe('createTpsScene', () => {
  it('shows the progress until the models are loaded', () => {
    const { backend } = fakeBackend();
    // A source that never answers.
    const source: ResourceSource = {
      read: () => new Promise(() => undefined),
    } as unknown as ResourceSource;
    const store = new ResourceStore();
    store.mount('never', source, { default: true });
    let info = '';
    const scene = createTpsScene({
      physics: {} as PhysicsEngine,
      resources: () => store,
    })(backend, surface, { info: (text) => (info = text) });
    scene.frame(0);
    scene.frame(0.1);
    expect(info).toBe('loading 0 %');
    scene.destroy();
  });
});
