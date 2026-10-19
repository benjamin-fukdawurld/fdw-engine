import type { IVec3, RenderBackend } from '@fdw/engine-backend';
import {
  AnimationGraphBuilder,
  type AnimationClip,
} from '@fdw/engine-animation';
import type { Model } from '@fdw/engine-assets';
import type { RenderGraph } from '@fdw/engine-core';
import type { PhysicsCollider, ScenePhysics } from '@fdw/engine-physics';
import { type BehaviorMode, BehaviorSystem } from '@fdw/engine-behavior';
import type { Scene } from '@fdw/engine-scene';
import { Actor } from './actor';
import {
  type EnemyActivity,
  enemyGraph,
  type EnemyHost,
  enemyRegistry,
} from './brain';
import { Blow, strikeSphere } from './combat';

/** What an enemy is: its model, its size, how it moves and strikes. */
export interface EnemyKind {
  readonly name: string;
  readonly scale: number;
  readonly radius: number;
  readonly halfHeight: number;
  readonly health: number;
  readonly walk: number;
  readonly run: number;
  // How far its blow reaches, how hard, how often.
  readonly reach: number;
  readonly damage: number;
  readonly cooldown: number;
  // The window of its blow in its attack clip, in seconds.
  readonly strike: readonly [number, number];
  // Blows weaker than this do not stop it.
  readonly poise: number;
}

/** The enemies of the forest: the orcs, and the demon that leads them. */
export const EnemyKinds = {
  orc: {
    name: 'orc',
    scale: 0.55,
    radius: 0.4,
    halfHeight: 0.48,
    health: 60,
    walk: 1.6,
    run: 4.2,
    reach: 1.9,
    damage: 12,
    cooldown: 1.3,
    strike: [0.28, 0.45],
    poise: 0,
  },
  demon: {
    name: 'demon',
    scale: 0.85,
    radius: 0.6,
    halfHeight: 0.75,
    health: 320,
    walk: 1.4,
    run: 3.3,
    reach: 2.7,
    damage: 30,
    cooldown: 2.2,
    strike: [0.28, 0.45],
    poise: 50,
  },
} as const satisfies Record<string, EnemyKind>;

/** What the enemies tell the sounds. */
export interface EnemyEvents {
  spawned?(at: IVec3, kind: EnemyKind): void;
  swing?(at: IVec3, kind: EnemyKind): void;
  hurt?(at: IVec3, kind: EnemyKind): void;
  death?(at: IVec3, kind: EnemyKind): void;
  step?(at: IVec3, kind: EnemyKind): void;
}

/** The animation graph of the monsters: locomotion by speed, an action at a time. */
function animationGraph(kind: EnemyKind) {
  const g = new AnimationGraphBuilder(`${kind.name}`);
  g.parameter('speed', 'number');
  g.parameter('action', 'number');
  const actions = [
    ['move', 0.25],
    ['attack', 0.1],
    ['hurt', 0.06],
    ['dead', 0.15],
  ] as const;
  g.output(
    g.stateMachine({
      label: 'body',
      initial: 'move',
      states: {
        move: g.blend1d(
          [g.clip('Idle'), g.clip('Walk'), g.clip('Run')],
          [0, kind.walk, kind.run],
          g.param('speed'),
        ),
        attack: g.clip('Weapon', { loop: false }),
        hurt: g.clip('HitReact', { loop: false, speed: 1.4 }),
        dead: g.clip('Death', { loop: false }),
      },
      transitions: actions.map(([to, duration], index) => ({
        from: '*',
        to,
        conditions: [{ parameter: 'action', value: index }],
        duration,
      })),
    }),
  );
  return g.build();
}

const actionOf: Record<string, number> = {
  spawn: 0,
  chase: 0,
  attack: 1,
  recover: 0,
  hurt: 2,
  dead: 3,
};

/** The trunks of the forest in a grid, to steer around them. */
export class TrunkGrid {
  private readonly _cells = new Map<number, number[]>();
  constructor(
    // x, z, radius per trunk.
    readonly trunks: Float32Array,
    readonly cell = 8,
  ) {
    for (let i = 0; i < trunks.length; i += 3) {
      const key = this.key(
        Math.floor(trunks[i] / cell),
        Math.floor(trunks[i + 1] / cell),
      );
      let list = this._cells.get(key);
      if (!list) this._cells.set(key, (list = []));
      list.push(i);
    }
  }

  private key(i: number, j: number): number {
    return (i + 512) * 1024 + (j + 512);
  }

  /** Calls `visit` with the trunks within `radius` of (x, z). */
  near(
    x: number,
    z: number,
    radius: number,
    visit: (tx: number, tz: number, r: number) => void,
  ): void {
    const c = this.cell;
    for (
      let j = Math.floor((z - radius) / c);
      j <= Math.floor((z + radius) / c);
      j++
    ) {
      for (
        let i = Math.floor((x - radius) / c);
        i <= Math.floor((x + radius) / c);
        i++
      ) {
        for (const t of this._cells.get(this.key(i, j)) ?? []) {
          const [tx, tz, r] = [
            this.trunks[t],
            this.trunks[t + 1],
            this.trunks[t + 2],
          ];
          if (Math.hypot(tx - x, tz - z) < radius + r) visit(tx, tz, r);
        }
      }
    }
  }
}

// The objects of an enemy.
interface Agent {
  readonly kind: EnemyKind;
  readonly actor: Actor;
  blow?: Blow;
}

/** What the enemies need of the hero. */
export interface Target {
  readonly position: IVec3;
  readonly alive: boolean;
  // Its body: what the blows of the enemies strike.
  readonly colliders: readonly PhysicsCollider[];
  hurt(damage: number, from: IVec3): boolean;
}

/**
 * The enemies: an entity per enemy, the body of an `Actor`, with an `enemy`
 * component (its kind, its place around the hero), and a behavior graph
 * deciding what each one does (`enemyGraph`, in `brain.ts`): the graph is
 * the system of the fixed step, its instances the enemies. This class is
 * the host of the graph: it does what the nodes of the game ask (steering
 * towards the hero, around the trunks and apart from each other; the blows
 * as volumes), and animates the enemies at each frame.
 *
 * No path finding: the forest is open ground with trunks to go around.
 */
export class Enemies implements EnemyHost {
  readonly Enemy;
  /** The graph of the enemies, run for each: install it in the fixed step. */
  readonly behavior: BehaviorSystem<EnemyHost>;
  events: EnemyEvents = {};
  /** At most this many strike at once: the others wait around. */
  maxAttackers = 2;
  /** The hero they fight. */
  target: Target | undefined;
  private readonly _query;
  private readonly _agents = new Map<number, Agent>();
  private readonly _graphs = new Map<
    string,
    ReturnType<typeof animationGraph>
  >();
  private readonly _bodies = new Set<PhysicsCollider>();

  constructor(
    readonly backend: RenderBackend,
    readonly scene: Scene,
    readonly physics: ScenePhysics,
    readonly models: Readonly<Record<string, Model>>,
    readonly trunks: TrunkGrid,
    options: { readonly mode?: BehaviorMode } = {},
  ) {
    this.Enemy = scene.world.defineComponent('enemy', {
      // Its place around the hero while it waits: an angle.
      around: 'f32',
    });
    this._query = scene.world.query(this.Enemy);
    this.behavior = new BehaviorSystem(enemyGraph(), {
      host: this,
      registry: enemyRegistry,
      mode: options.mode ?? 'compile',
    });
  }

  /** How many are alive (not falling). */
  get alive(): number {
    let count = 0;
    for (const instance of this.behavior.instances) {
      if (instance.variables['state'] !== 'dead') count++;
    }
    return count;
  }

  /** The entities of the enemies. */
  get entities(): Uint32Array {
    return this._query.entities;
  }

  /** The state of an enemy: the `state` variable of its graph. */
  state(entity: number): EnemyActivity {
    return (this.behavior.instance(entity)?.variables['state'] ??
      'dead') as EnemyActivity;
  }

  health(entity: number): number {
    return (this.behavior.instance(entity)?.variables['health'] ?? 0) as number;
  }

  agent(entity: number): Agent | undefined {
    return this._agents.get(entity);
  }

  /** Whether a collider is the body of an enemy (what the sword strikes). */
  isEnemy = (collider: PhysicsCollider): boolean => this._bodies.has(collider);

  /** The enemy of a collider, if it is one. */
  enemyOf(collider: PhysicsCollider): number | undefined {
    const entity = this.physics.entityOf(collider);
    return entity !== undefined && this._agents.has(entity)
      ? entity
      : undefined;
  }

  /** A new enemy at a place on the ground, facing the hero. */
  spawn(kind: EnemyKind, at: IVec3, facing: IVec3): number {
    let graph = this._graphs.get(kind.name);
    if (!graph) this._graphs.set(kind.name, (graph = animationGraph(kind)));
    const actor = new Actor(this.backend, this.scene, this.physics, at, {
      model: this.models[kind.name],
      scale: kind.scale,
      radius: kind.radius,
      halfHeight: kind.halfHeight,
      graph,
      clips: (clips) => withSteps(clips),
    });
    actor.face({ x: facing.x - at.x, z: facing.z - at.z }, 1, 100);
    const entity = actor.body.entity;
    this.scene.world.add(entity, this.Enemy, {
      around: Math.random() * Math.PI * 2,
    });
    // The kind, in the variables of its graph.
    this.behavior.attach(entity, {
      health: kind.health,
      cooldown: 0.5 + Math.random(),
      reach: kind.reach,
      poise: kind.poise,
      rest: kind.cooldown,
      strikeStart: kind.strike[0],
      strikeEnd: kind.strike[1],
      attackLength: actor.clips['Weapon'].duration,
    });
    actor.character.body.colliders.forEach((c) => this._bodies.add(c));
    const agent: Agent = { kind, actor };
    this._agents.set(entity, agent);
    actor.animator.onEvent((event) => {
      if (
        event.name === 'step' &&
        event.weight > 0.5 &&
        this.state(entity) === 'chase'
      ) {
        this.events.step?.(actor.body.worldPosition, kind);
      }
    });
    this.events.spawned?.(at, kind);
    return entity;
  }

  /** A blow of the hero: the `hit` event of its graph. */
  hit(entity: number, damage: number): void {
    this.behavior.emit(entity, 'hit', { damage });
  }

  // --- What the graph asks ----------------------------------------------

  get heroAlive(): boolean {
    return this.target?.alive ?? false;
  }

  attackers(): number {
    let count = 0;
    for (const instance of this.behavior.instances) {
      if (instance.variables['state'] === 'attack') count++;
    }
    return count;
  }

  heroDistance(entity: number): number {
    const agent = this._agents.get(entity);
    if (!agent || !this.target) return Infinity;
    const p = agent.actor.body.worldPosition;
    const h = this.target.position;
    return Math.hypot(h.x - p.x, h.z - p.z);
  }

  startAttack(entity: number): void {
    const agent = this._agents.get(entity);
    const hero = this.target;
    if (!agent || !hero) return;
    agent.blow = new Blow(agent.kind.damage, (c) => hero.colliders.includes(c));
  }

  swing(entity: number): void {
    const agent = this._agents.get(entity);
    if (agent) this.events.swing?.(agent.actor.body.worldPosition, agent.kind);
  }

  /** The blow in front of the enemy, against the hero. */
  strike(entity: number): void {
    const agent = this._agents.get(entity);
    if (!agent?.blow || !this.target) return;
    const { actor, kind, blow } = agent;
    const p = actor.body.worldPosition;
    const f = actor.forward;
    // In front, at the height of the chest, as far as the blow reaches.
    const center = {
      x: p.x + f.x * kind.reach * 0.6,
      y: p.y + 0.2,
      z: p.z + f.z * kind.reach * 0.6,
    };
    const world = this.physics.world;
    if (strikeSphere(world, blow, center, kind.reach * 0.45).length > 0) {
      this.target.hurt(kind.damage, p);
    }
  }

  /**
   * Moves an enemy for a step: chasing, to the hero or its place around it,
   * apart from the others, around the trunks ahead; turned towards the hero
   * while it strikes; still otherwise.
   */
  steer(
    entity: number,
    step: number,
    state: string,
    time: number,
    cooldown: number,
  ): void {
    const agent = this._agents.get(entity);
    const hero = this.target;
    if (!agent || !hero) return;
    const { kind, actor } = agent;
    const p = actor.body.worldPosition;
    const to = { x: hero.position.x - p.x, z: hero.position.z - p.z };
    const distance = Math.hypot(to.x, to.z) || 1;
    let velocity = { x: 0, z: 0 };
    if (state === 'chase' && hero.alive) {
      // Its own place around the hero while others strike; the hero
      // itself when its turn comes.
      const waiting = this.attackers() >= this.maxAttackers || cooldown > 0;
      const ring = kind.reach + 2;
      const around = this.Enemy.around[entity];
      const goal = waiting
        ? {
            x: hero.position.x + Math.cos(around) * ring,
            z: hero.position.z + Math.sin(around) * ring,
          }
        : hero.position;
      const g = { x: goal.x - p.x, z: goal.z - p.z };
      const gd = Math.hypot(g.x, g.z);
      const near = waiting ? 0.5 : kind.reach * 0.7;
      if (gd > near) {
        const pace =
          distance > 10 ? kind.run : waiting ? kind.walk : kind.run * 0.8;
        velocity = { x: (g.x / gd) * pace, z: (g.z / gd) * pace };
      }
      // Apart from the others.
      for (const [other, { actor: neighbour }] of this._agents) {
        if (other === entity) continue;
        const q = neighbour.body.worldPosition;
        const away = { x: p.x - q.x, z: p.z - q.z };
        const d = Math.hypot(away.x, away.z);
        if (d > 0 && d < 1.8) {
          velocity.x += (away.x / d) * (1.8 - d) * 3;
          velocity.z += (away.z / d) * (1.8 - d) * 3;
        }
      }
      // Around the trunks ahead: a push sideways.
      const speed = Math.hypot(velocity.x, velocity.z);
      if (speed > 0.1) {
        const dir = { x: velocity.x / speed, z: velocity.z / speed };
        this.trunks.near(p.x, p.z, 2.5, (tx, tz, r) => {
          const t = { x: tx - p.x, z: tz - p.z };
          const ahead = t.x * dir.x + t.z * dir.z;
          if (ahead <= 0) return;
          const side = t.x * dir.z - t.z * dir.x;
          const clearance = kind.radius + r + 0.3;
          if (Math.abs(side) < clearance) {
            // Steer to the side the trunk is not on: (-dir.z, dir.x)
            // points away from a trunk on the side > 0.
            const sign = side >= 0 ? 1 : -1;
            const push =
              ((clearance - Math.abs(side)) / clearance) * speed * 1.5;
            velocity.x += -dir.z * sign * push;
            velocity.z += dir.x * sign * push;
          }
        });
      }
      actor.face(waiting && gd < 1 ? to : velocity, step, 8);
    } else if (state === 'attack' || state === 'recover' || state === 'spawn') {
      // Turned towards the hero, slower once the blow is on its way.
      actor.face(to, step, state === 'attack' && time > kind.strike[0] ? 1 : 6);
    }
    actor.move(step, velocity);
    if (state !== 'dead') {
      actor.animator.set('speed', Math.hypot(velocity.x, velocity.z));
    }
  }

  hurt(entity: number): void {
    const agent = this._agents.get(entity);
    if (agent) this.events.hurt?.(agent.actor.body.worldPosition, agent.kind);
  }

  die(entity: number): void {
    const agent = this._agents.get(entity);
    if (!agent) return;
    // The body no longer blocks the way, nor takes blows.
    agent.actor.character.body.colliders.forEach((c) => this._bodies.delete(c));
    this.events.death?.(agent.actor.body.worldPosition, agent.kind);
  }

  sink(entity: number, time: number): void {
    const agent = this._agents.get(entity);
    if (!agent) return;
    const { actor } = agent;
    actor.visual.transform.position = {
      y: -actor.halfHeight - actor.radius - (time - 2.5) * 0.8,
    };
  }

  // --- The frame ---------------------------------------------------------

  /** A frame: the animations and the skins. */
  animate(dt: number): void {
    for (const [entity, { actor }] of this._agents) {
      actor.animator.set('action', actionOf[this.state(entity)] ?? 0);
      actor.animate(dt);
    }
  }

  /** Skins the enemies in the graph of the frame. */
  addPasses(graph: RenderGraph): void {
    for (const agent of this._agents.values()) agent.actor.addPass(graph);
  }

  /** Removes an enemy at once. */
  remove(entity: number): void {
    const agent = this._agents.get(entity);
    if (!agent) return;
    this.behavior.detach(entity);
    agent.actor.character.body.colliders.forEach((c) => this._bodies.delete(c));
    this._agents.delete(entity);
    this.physics.remove(agent.actor.body);
    agent.actor.destroy();
  }

  /** Removes every enemy. */
  clear(): void {
    for (const entity of [...this._agents.keys()]) this.remove(entity);
  }
}

// The steps of the walk and the run, for the sounds.
function withSteps(
  clips: Record<string, AnimationClip>,
): Record<string, AnimationClip> {
  const out = { ...clips };
  for (const name of ['Walk', 'Run']) {
    const d = clips[name].duration;
    out[name] = clips[name].withEvents([
      { time: d * 0.25, name: 'step' },
      { time: d * 0.75, name: 'step' },
    ]);
  }
  return out;
}
