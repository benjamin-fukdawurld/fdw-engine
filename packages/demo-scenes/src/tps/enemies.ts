import type { IVec3, RenderBackend } from '@fdw/engine-backend';
import {
  AnimationGraphBuilder,
  type AnimationClip,
  type AnimationGraphData,
  type Pose,
} from '@fdw/engine-animation';
import { animatorsTarget, type GraphTarget } from '@fdw/engine-graph-editing';
import type { Model } from '@fdw/engine-assets';
import type { RenderGraph } from '@fdw/engine-core';
import type { PhysicsCollider, ScenePhysics } from '@fdw/engine-physics';
import { type BehaviorMode, BehaviorSystem } from '@fdw/engine-behavior';
import {
  type CrowdAgent,
  NavAgent,
  NavCrowd,
  type NavMesh,
} from '@fdw/engine-navigation';
import { Ragdoll, type RagdollBone } from '@fdw/engine-ragdoll';
import type { Scene } from '@fdw/engine-scene';
import { Actor, Groups } from './actor';
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

/**
 * The bodies of a monster when it falls (the rig of Ultimate Monsters):
 * capsules from joint to joint in meters for the orc, scaled with the
 * kind; the limbs held in cones, the feet (moved by inverse kinematics,
 * under the root of the rig) hung on the lower legs.
 */
export function monsterBones(kind: EnemyKind): RagdollBone[] {
  const k = kind.scale / EnemyKinds.orc.scale;
  const side = (s: 'L' | 'R'): RagdollBone[] => [
    {
      joint: `UpperArm.${s}`,
      to: `LowerArm.${s}`,
      radius: 0.08 * k,
      cone: 1.3,
      twist: [-0.6, 0.6],
    },
    {
      joint: `LowerArm.${s}`,
      to: `Middle1.${s}`,
      radius: 0.07 * k,
      cone: 1.2,
      twist: [-0.3, 0.3],
    },
    {
      joint: `UpperLeg.${s}`,
      to: `LowerLeg.${s}`,
      radius: 0.1 * k,
      cone: 0.9,
      twist: [-0.3, 0.3],
    },
    {
      joint: `LowerLeg.${s}`,
      to: `Foot.${s}`,
      radius: 0.08 * k,
      cone: 1.1,
      twist: [-0.2, 0.2],
    },
    {
      joint: `Foot.${s}`,
      radius: 0.07 * k,
      attach: `LowerLeg.${s}`,
      cone: 0.6,
    },
  ];
  return [
    { joint: 'Hips', to: 'Abdomen', radius: 0.17 * k },
    {
      joint: 'Abdomen',
      to: 'Neck',
      radius: 0.2 * k,
      cone: 0.5,
      twist: [-0.3, 0.3],
    },
    { joint: 'Head', radius: 0.16 * k, cone: 0.6, twist: [-0.5, 0.5] },
    ...side('L'),
    ...side('R'),
  ];
}

// The objects of an enemy.
interface Agent {
  readonly kind: EnemyKind;
  readonly actor: Actor;
  blow?: Blow;
  // Its path on the navigation mesh, its place in the crowd.
  readonly nav: NavAgent;
  readonly crowd: CrowdAgent;
  // Where its path goes, and when it may look for another.
  goal?: { x: number; z: number };
  repath: number;
  // Where it turns while it moves (towards where it goes, by default).
  facing?: { x: number; z: number };
  turn: number;
  // Where the last blow came from, on the ground.
  struck: { x: number; z: number };
  // Its bodies once fallen.
  ragdoll?: Ragdoll;
  pose?: Pose;
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
 * the host of the graph: it does what the nodes of the game ask (a path on
 * the navigation mesh of the forest towards the hero or a place around it;
 * the blows as volumes), moves them as a crowd that makes way (`move`,
 * after the graph), and animates them at each frame. The fallen fall as
 * ragdolls.
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
  private readonly _graphs = new Map<string, AnimationGraphData>();
  private readonly _bodies = new Set<PhysicsCollider>();
  private _targets?: readonly GraphTarget[];
  /** The enemies, as agents making way for each other. */
  readonly crowd = new NavCrowd({ timeHorizon: 1, neighborDistance: 5 });

  constructor(
    readonly backend: RenderBackend,
    readonly scene: Scene,
    readonly physics: ScenePhysics,
    readonly models: Readonly<Record<string, Model>>,
    /** Where they walk: the ground of the forest, around the trunks. */
    readonly navMesh: NavMesh,
    options: { readonly mode?: BehaviorMode } = {},
  ) {
    this.Enemy = scene.world.defineComponent('enemy', {
      // Its place around the hero while it waits: an angle.
      around: 'f32',
    });
    this._query = scene.world.query(this.Enemy);
    this.behavior = new BehaviorSystem<EnemyHost>(enemyGraph(), {
      host: this,
      registry: enemyRegistry,
      mode: options.mode ?? 'compile',
    });
  }

  /**
   * The graphs an editor may change while the game runs: the mind of the
   * enemies, and the animation graph of each kind (those spawned later play
   * the graph edited).
   */
  get graphs(): readonly GraphTarget[] {
    this._targets ??= [
      {
        kind: 'behavior',
        id: 'tps/enemies',
        name: 'Enemies',
        system: this.behavior as BehaviorSystem<unknown>,
        registry: enemyRegistry,
        entityName: (entity) =>
          `${this._agents.get(entity)?.kind.name ?? 'enemy'} ${entity}`,
      },
      ...Object.values(EnemyKinds).map((kind) =>
        animatorsTarget(`tps/${kind.name}`, `${kind.name} animation`, {
          graph: () => this.animationGraphOf(kind),
          animators: () =>
            [...this._agents]
              .filter(([, agent]) => agent.kind === kind)
              .map(([entity, agent]) => ({
                name: `${kind.name} ${entity}`,
                animator: agent.actor.animator,
              })),
          onApply: (graph) => this._graphs.set(kind.name, graph),
        }),
      ),
    ];
    return this._targets;
  }

  // The animation graph of a kind, made at its first use.
  private animationGraphOf(kind: EnemyKind) {
    let graph = this._graphs.get(kind.name);
    if (!graph) this._graphs.set(kind.name, (graph = animationGraph(kind)));
    return graph;
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
    const graph = this.animationGraphOf(kind);
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
    const agent: Agent = {
      kind,
      actor,
      nav: new NavAgent(this.navMesh, {
        speed: kind.run,
        partial: true,
        maxDistance: 4,
        maxDeviation: 1.5,
      }),
      crowd: this.crowd.add({
        radius: kind.radius,
        maxSpeed: kind.run,
        position: at,
      }),
      repath: 0,
      turn: 8,
      struck: { x: 0, z: 0 },
    };
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

  /** A blow of the hero, from a point: the `hit` event of its graph. */
  hit(entity: number, damage: number, from?: IVec3): void {
    const agent = this._agents.get(entity);
    if (agent && from) {
      const p = agent.actor.body.worldPosition;
      const d = Math.hypot(p.x - from.x, p.z - from.z) || 1;
      agent.struck = { x: (p.x - from.x) / d, z: (p.z - from.z) / d };
    }
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
   * How an enemy would move for a step: chasing, along its path to the
   * hero or its place around it; turned towards the hero while it
   * strikes; still otherwise. The crowd moves them all after ({@link move}).
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
    if (!agent || !hero || agent.ragdoll) return;
    const { kind, actor, nav, crowd } = agent;
    const p = actor.body.worldPosition;
    crowd.moveTo(p.x, p.z);
    // The strikers hold their ground: the others go around them.
    crowd.avoids = state === 'chase';
    agent.repath -= step;
    agent.facing = undefined;
    const to = { x: hero.position.x - p.x, z: hero.position.z - p.z };
    let vx = 0;
    let vz = 0;
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
        : { x: hero.position.x, z: hero.position.z };
      const g = { x: goal.x - p.x, z: goal.z - p.z };
      const gd = Math.hypot(g.x, g.z);
      const near = waiting ? 0.5 : kind.reach * 0.7;
      if (gd > near) {
        const pace =
          Math.hypot(to.x, to.z) > 10
            ? kind.run
            : waiting
              ? kind.walk
              : kind.run * 0.8;
        nav.speed = pace;
        crowd.maxSpeed = pace;
        // A new path when the goal moved, a few times a second at most.
        const moved =
          !agent.goal ||
          Math.hypot(goal.x - agent.goal.x, goal.z - agent.goal.z) > 0.75;
        const feet = actor.feet;
        if ((moved || nav.idle) && agent.repath <= 0) {
          agent.goal = goal;
          agent.repath = 0.3;
          nav.setDestination(feet, {
            x: goal.x,
            y: hero.position.y - 0.9,
            z: goal.z,
          });
        }
        if (nav.idle) {
          // No path (a goal off the mesh, on a slope): straight there.
          vx = (g.x / gd) * pace;
          vz = (g.z / gd) * pace;
        } else {
          const along = nav.update(feet, step);
          vx = along.x / step;
          vz = along.z / step;
        }
      } else {
        nav.stop();
        agent.goal = undefined;
      }
      if (waiting && gd < 1) agent.facing = to;
      agent.turn = 8;
    } else if (state === 'attack' || state === 'recover' || state === 'spawn') {
      // Turned towards the hero, slower once the blow is on its way.
      agent.facing = to;
      agent.turn = state === 'attack' && time > kind.strike[0] ? 1 : 6;
      nav.stop();
      agent.goal = undefined;
    }
    crowd.prefer(vx, vz);
  }

  /**
   * Moves the enemies for a step, as a crowd: each makes way for the
   * others, as close to the way it would go as they let it. After the
   * graph, before the physics.
   */
  move(step: number): void {
    this.crowd.update(step);
    for (const [entity, agent] of this._agents) {
      if (agent.ragdoll || this.state(entity) === 'dead') continue;
      const { actor, crowd } = agent;
      const velocity = crowd.velocity;
      actor.face(agent.facing ?? velocity, step, agent.turn);
      actor.move(step, velocity);
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
    const { actor, kind } = agent;
    this.events.death?.(actor.body.worldPosition, kind);
    // The body no longer blocks the way, nor takes blows; it falls as a
    // ragdoll from its pose, pushed away from the blow.
    actor.character.body.colliders.forEach((c) => this._bodies.delete(c));
    this.physics.remove(actor.body);
    this.crowd.remove(agent.crowd);
    agent.nav.stop();
    const skeleton = actor.skinning.skeleton;
    agent.ragdoll = new Ragdoll(this.physics.world, skeleton, {
      bones: monsterBones(kind),
      groups: Groups.ragdolls,
      mask: Groups.level,
      material: { friction: 0.9 },
    });
    agent.pose = skeleton.rest.clone();
    agent.ragdoll.activate(
      actor.animator.pose,
      actor.instance.root.worldMatrix,
      { x: agent.struck.x * 3, y: 1.5, z: agent.struck.z * 3 },
    );
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

  /** A frame: the animations and the skins; the poses of the fallen. */
  animate(dt: number): void {
    for (const [entity, { actor, ragdoll, pose }] of this._agents) {
      if (ragdoll && pose) {
        actor.applyPose(ragdoll.readPose(pose));
        continue;
      }
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
    agent.ragdoll?.deactivate();
    this.crowd.remove(agent.crowd);
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
