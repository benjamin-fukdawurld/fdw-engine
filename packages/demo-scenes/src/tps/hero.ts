import type { IVec3, RenderBackend } from '@fdw/engine-backend';
import {
  AnimationGraphBuilder,
  type AnimationClip,
  type AnimationEvent,
} from '@fdw/engine-animation';
import type { Model } from '@fdw/engine-assets';
import type { PhysicsCollider, ScenePhysics } from '@fdw/engine-physics';
import type { Node, Scene } from '@fdw/engine-scene';
import { Actor } from './actor';
import { Blow, strikeCapsule, type Strike } from './combat';

/** What the hero does: one state at a time, chosen by the game. */
export const HeroActions = [
  'move',
  'air',
  'land',
  'roll',
  'attackA',
  'attackB',
  'attackC',
  'recoverA',
  'recoverB',
  'heavy',
  'block',
  'hit',
  'dead',
] as const;
export type HeroAction = (typeof HeroActions)[number];

/** What the player asks for a step. */
export interface HeroIntent {
  // Where to go, on the ground, of length 0 to 1 (the stick pushed).
  readonly move: { readonly x: number; readonly z: number };
  readonly sprint: boolean;
  // Pressed this step.
  readonly jump: boolean;
  readonly roll: boolean;
  readonly attack: boolean;
  readonly heavy: boolean;
  // Held.
  readonly block: boolean;
  // Where to strike: the enemy nearest in front, else where the camera
  // looks.
  readonly aim: { readonly x: number; readonly z: number };
}

/** What the hero tells the sounds. */
export interface HeroEvents {
  step?(): void;
  swing?(heavy: boolean): void;
  jump?(): void;
  land?(): void;
  roll?(): void;
  hurt?(): void;
  blocked?(): void;
  death?(): void;
}

// The clip of each action, its speed, its cross-fade.
const clipOf: Partial<
  Record<
    HeroAction,
    { clip: string; speed?: number; fade: number; loop?: boolean }
  >
> = {
  air: { clip: 'JumpLoop', fade: 0.15, loop: true },
  land: { clip: 'JumpLand', speed: 1.6, fade: 0.08 },
  roll: { clip: 'Roll', speed: 1.65, fade: 0.06 },
  attackA: { clip: 'AttackA', fade: 0.08 },
  attackB: { clip: 'AttackB', fade: 0.06 },
  attackC: { clip: 'AttackC', fade: 0.06 },
  recoverA: { clip: 'AttackARecover', speed: 1.3, fade: 0.1 },
  recoverB: { clip: 'AttackBRecover', speed: 1.3, fade: 0.1 },
  heavy: { clip: 'HeavyAttack', speed: 1.15, fade: 0.1 },
  block: { clip: 'Block', speed: 1.5, fade: 0.1 },
  hit: { clip: 'Hit', speed: 0.8, fade: 0.05 },
  dead: { clip: 'Death', fade: 0.15 },
};

// The windows where the blade strikes (seconds of the clips), from the
// speed of the hand, and the damage of each blow.
const strikes: Record<string, { windows: [number, number][]; damage: number }> =
  {
    AttackA: { windows: [[0.15, 0.32]], damage: 20 },
    AttackB: { windows: [[0.17, 0.32]], damage: 25 },
    AttackC: {
      windows: [
        [0.12, 0.3],
        [0.55, 0.72],
      ],
      damage: 30,
    },
    HeavyAttack: { windows: [[0.3, 0.5]], damage: 55 },
  };

/** The events of the clips of the hero: steps, swings, the blade striking. */
export function heroClips(
  clips: Record<string, AnimationClip>,
): Record<string, AnimationClip> {
  const out = { ...clips };
  const steps = (name: string) => {
    const d = clips[name].duration;
    out[name] = clips[name].withEvents([
      { time: d * 0.25, name: 'step' },
      { time: d * 0.75, name: 'step' },
    ]);
  };
  ['Walk', 'Jog', 'Sprint'].forEach(steps);
  for (const [name, { windows }] of Object.entries(strikes)) {
    const events: AnimationEvent[] = [];
    for (const [start, end] of windows) {
      events.push(
        { time: Math.max(start - 0.05, 0.001), name: 'swing' },
        { time: start, name: 'strike' },
        { time: end, name: 'strikeEnd' },
      );
    }
    out[name] = clips[name].withEvents(events);
  }
  return out;
}

/** The animation graph of the hero: locomotion by speed, an action at a time. */
export function heroGraph() {
  const g = new AnimationGraphBuilder('hero');
  g.parameter('speed', 'number');
  g.parameter('action', 'number');
  const move = g.blend1d(
    [g.clip('SwordIdle'), g.clip('Walk'), g.clip('Jog'), g.clip('Sprint')],
    [0, 1.6, 4.5, 7],
    g.param('speed'),
  );
  const states: Record<string, ReturnType<typeof g.clip>> = { move };
  for (const [action, entry] of Object.entries(clipOf)) {
    states[action] = g.clip(entry.clip, {
      loop: entry.loop ?? false,
      speed: entry.speed ?? 1,
    });
  }
  g.output(
    g.stateMachine({
      label: 'body',
      states,
      initial: 'move',
      transitions: HeroActions.map((action, index) => ({
        from: '*',
        to: action,
        conditions: [{ parameter: 'action', value: index }],
        duration: clipOf[action]?.fade ?? 0.2,
      })),
    }),
  );
  return g.build();
}

const walk = 2;
const jog = 4.5;
const sprint = 7;

/**
 * The hero: a ranger with an estoc, on a character controller. Moves
 * where the player asks, relative to the camera; jumps, rolls (unhurt for
 * most of it), chains three blows, strikes hard, parries. The blade is a
 * capsule tested while the animation strikes.
 */
export class Hero {
  readonly actor: Actor;
  readonly sword: Node;
  readonly maxHealth = 100;
  health = this.maxHealth;
  action: HeroAction = 'move';
  /** Seconds in the current action. */
  time = 0;
  /** Horizontal speed, in m/s. */
  speed = 0;
  events: HeroEvents = {};
  private _velocity = { x: 0, z: 0 };
  private _queued = false;
  private _blow: Blow | undefined;
  private _striking = false;
  private _durations: Record<string, number> = {};
  private readonly _tip = { x: 0, y: 0, z: 0 };
  private _hasTip = false;

  constructor(
    backend: RenderBackend,
    scene: Scene,
    readonly physics: ScenePhysics,
    model: Model,
    position: IVec3,
    // The colliders it may strike.
    readonly enemies: (collider: PhysicsCollider) => boolean,
  ) {
    this.actor = new Actor(backend, scene, physics, position, {
      model,
      radius: 0.32,
      halfHeight: 0.6,
      graph: heroGraph(),
      clips: heroClips,
    });
    // Facing away from a camera looking along -z.
    this.actor.yaw = Math.PI;
    const index = model.data.nodes.findIndex((node) => node.name === 'Sword');
    this.sword = this.actor.instance.nodes[index];
    for (const [action, entry] of Object.entries(clipOf)) {
      const clip = this.actor.clips[entry.clip];
      this._durations[action] = clip ? clip.duration / (entry.speed ?? 1) : 0.5;
    }
    this.actor.animator.onEvent((event) => {
      // Only the events of the action playing: not those of the one
      // fading out.
      if (event.weight < 0.5) return;
      if (event.name === 'step' && this.action === 'move') this.events.step?.();
      if (event.name === 'swing') this.events.swing?.(this.action === 'heavy');
      if (event.name === 'strike') {
        const damage = strikes[event.clip]?.damage ?? 20;
        this._blow = new Blow(damage, this.enemies);
        this._striking = true;
        this._hasTip = false;
      }
      if (event.name === 'strikeEnd') this._striking = false;
    });
  }

  get alive(): boolean {
    return this.action !== 'dead';
  }

  /** Unhurt: rolling (but its start and end), or down. */
  get invulnerable(): boolean {
    return (
      (this.action === 'roll' && this.time > 0.05 && this.time < 0.6) ||
      this.action === 'dead'
    );
  }

  /** The body: the colliders the enemies strike. */
  get colliders(): readonly PhysicsCollider[] {
    return this.actor.character.body.colliders;
  }

  private enter(action: HeroAction): void {
    this.action = action;
    this.time = 0;
    this._striking = false;
    this._queued = false;
  }

  /** A fixed step: the player's intent, the moves, the blows. */
  step(dt: number, intent: HeroIntent): Strike[] {
    const actor = this.actor;
    this.time += dt;
    const duration = this._durations[this.action] ?? 0;
    const done = this.time >= duration;
    let target = { x: 0, z: 0 };
    let turn = 0;
    switch (this.action) {
      case 'dead':
        break;
      case 'move': {
        const length = Math.hypot(intent.move.x, intent.move.z);
        const max = intent.sprint ? sprint : length < 0.6 ? walk / 0.6 : jog;
        target = { x: intent.move.x * max, z: intent.move.z * max };
        turn = 12;
        if (intent.jump && actor.grounded) {
          actor.fall = 7;
          actor.grounded = false;
          this.events.jump?.();
          this.enter('air');
        } else if (intent.roll) {
          this.events.roll?.();
          this.enter('roll');
        } else if (intent.attack) {
          this.enter('attackA');
        } else if (intent.heavy) {
          this.enter('heavy');
        } else if (intent.block) {
          this.enter('block');
        } else if (!actor.grounded && actor.fall < -4) {
          this.enter('air');
        }
        break;
      }
      case 'air':
        target = { ...this._velocity };
        turn = 4;
        if (actor.grounded && this.time > 0.1) {
          this.events.land?.();
          this.enter('land');
        }
        break;
      case 'land':
        if (this.time > 0.2) this.enter('move');
        break;
      case 'roll': {
        const f = actor.forward;
        const pace = this.time < 0.6 ? 7 : 3;
        target = { x: f.x * pace, z: f.z * pace };
        if (done) this.enter('move');
        break;
      }
      case 'attackA':
      case 'attackB':
      case 'attackC':
      case 'heavy': {
        // A step forward as the blow starts, turned towards the aim.
        const f = actor.forward;
        const lunge = this.time < duration * 0.45 ? 1.6 : 0;
        target = { x: f.x * lunge, z: f.z * lunge };
        if (this.time < duration * 0.3) {
          actor.face(intent.aim, dt, 14);
        }
        if (intent.attack && this.action !== 'heavy') this._queued = true;
        const next =
          this.action === 'attackA'
            ? 'attackB'
            : this.action === 'attackB'
              ? 'attackC'
              : undefined;
        // The next blow once this one has struck; else its recovery.
        if (next && this._queued && this.time > duration * 0.6) {
          this.enter(next);
        } else if (intent.roll && this.time > duration * 0.5) {
          this.events.roll?.();
          this.enter('roll');
        } else if (done) {
          this.enter(
            this.action === 'attackA'
              ? 'recoverA'
              : this.action === 'attackB'
                ? 'recoverB'
                : 'move',
          );
        }
        break;
      }
      case 'recoverA':
      case 'recoverB':
        // Moving or striking again cuts the recovery short.
        if (intent.attack) {
          this.enter(this.action === 'recoverA' ? 'attackB' : 'attackC');
        } else if (
          done ||
          intent.roll ||
          Math.hypot(intent.move.x, intent.move.z) > 0.2
        ) {
          this.enter('move');
        }
        break;
      case 'block':
        turn = 8;
        if (!intent.block) this.enter('move');
        break;
      case 'hit':
        if (this.time > 0.4) this.enter('move');
        break;
    }
    if (turn > 0 && this.action !== 'air') {
      actor.face(target.x || target.z ? target : { x: 0, z: 0 }, dt, turn);
    }
    // Speeding up and slowing down, quicker on the ground.
    const rate = actor.grounded
      ? 1 - Math.exp(-dt * 14)
      : 1 - Math.exp(-dt * 2);
    this._velocity.x += (target.x - this._velocity.x) * rate;
    this._velocity.z += (target.z - this._velocity.z) * rate;
    actor.move(dt, this._velocity);
    this.speed = Math.hypot(this._velocity.x, this._velocity.z);
    return this.strike();
  }

  /** The blade, from the guard to the tip, in the world. */
  blade(): { from: IVec3; to: IVec3 } {
    const m = this.sword.worldMatrix;
    const at = (z: number) => ({
      x: m[8] * z + m[12],
      y: m[9] * z + m[13],
      z: m[10] * z + m[14],
    });
    return { from: at(-0.1), to: at(-1.25) };
  }

  // While the blade strikes: the blade, and its sweep since the last step
  // (a fast blade crosses a body between two steps).
  private strike(): Strike[] {
    if (!this._striking || !this._blow || !this.alive) return [];
    const world = this.physics.world;
    const { from, to } = this.blade();
    const struck = strikeCapsule(world, this._blow, from, to, 0.12);
    if (this._hasTip) {
      struck.push(...strikeCapsule(world, this._blow, this._tip, to, 0.15));
    }
    Object.assign(this._tip, to);
    this._hasTip = true;
    return struck;
  }

  /**
   * A blow from `from` (a position): parried from the front, avoided by a
   * roll. Returns whether it hurt.
   */
  hurt(damage: number, from: IVec3): boolean {
    if (this.invulnerable) return false;
    const p = this.actor.body.worldPosition;
    const toward = { x: from.x - p.x, z: from.z - p.z };
    const length = Math.hypot(toward.x, toward.z) || 1;
    const f = this.actor.forward;
    const front = (toward.x * f.x + toward.z * f.z) / length > 0.3;
    if (this.action === 'block' && front) {
      this.health -= damage * 0.15;
      this.events.blocked?.();
    } else {
      this.health -= damage;
      this.events.hurt?.();
      if (this.health > 0 && this.action !== 'heavy') this.enter('hit');
    }
    if (this.health <= 0) {
      this.health = 0;
      this.enter('dead');
      this.events.death?.();
    }
    return true;
  }

  /** Back on its feet, full health, at a place. */
  revive(position: IVec3): void {
    this.health = this.maxHealth;
    this.enter('move');
    this.actor.yaw = Math.PI;
    this._velocity = { x: 0, z: 0 };
    this.actor.fall = 0;
    this.physics.teleport(this.actor.body, {
      x: position.x,
      y: position.y + this.actor.halfHeight + this.actor.radius,
      z: position.z,
    });
  }

  /** A frame: the animation. */
  animate(dt: number): void {
    const animator = this.actor.animator;
    animator.set('speed', this.action === 'move' ? this.speed : 0);
    animator.set('action', HeroActions.indexOf(this.action));
    this.actor.animate(dt);
  }

  destroy(): void {
    this.actor.destroy();
  }
}
