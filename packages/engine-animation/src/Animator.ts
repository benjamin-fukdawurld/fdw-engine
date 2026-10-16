import { GraphError, type Registry } from '@fdw/engine-graph';
import {
  additiveClip,
  type AnimationClip,
  type AnimationEvent,
} from './AnimationClip';
import type { BoneMask } from './BoneMask';
import type {
  AnimationGraphData,
  TransitionCondition,
  TransitionDescription,
} from './graph/data';
import {
  type AnimationNodeType,
  createAnimationRegistry,
  statesOf,
  transitionsOf,
} from './graph/nodes';
import { validateAnimationGraph } from './graph/validate';
import { Pose } from './Pose';
import type { Skeleton } from './Skeleton';

/**
 * An event of a clip reached by an {@link Animator.update}.
 *
 * @group Animator
 */
export interface FiredEvent extends AnimationEvent {
  /** The clip of the event. */
  readonly clip: string;
  /** The weight of the clip in the pose, from 0 to 1. */
  readonly weight: number;
}

/**
 * Where a state machine is: its state, the state it fades to, how far.
 *
 * @group Animator
 */
export interface StateMachineStatus {
  readonly state: string;
  /** The state of the cross-fade in progress. */
  readonly next?: string;
  /** From 0 to 1, along the cross-fade. */
  readonly progress: number;
  /** Seconds since the state (or the next one) was entered. */
  readonly time: number;
}

/**
 * The options of an {@link Animator}.
 *
 * @group Animator
 */
export interface AnimatorOptions {
  readonly skeleton: Skeleton;
  /** The clips the graph plays, by name. */
  readonly clips:
    readonly AnimationClip[] | Readonly<Record<string, AnimationClip>>;
  /** The masks of the layers, by name. */
  readonly masks?: Readonly<Record<string, BoneMask>>;
  readonly registry?: Registry<AnimationNodeType>;
}

interface Context {
  readonly skeleton: Skeleton;
  frame: number;
  emit(event: AnimationEvent, clip: string, weight: number): void;
}

type NumberSource = () => number;

// A node of the graph, running. advance() and setPhase() move it in time
// once per frame, whatever the number of nodes it feeds; evaluate() gives
// its pose, computed once per frame.
abstract class RuntimeNode {
  protected readonly out: Pose;
  private _advanced = -1;
  private _evaluated = -1;

  constructor(protected readonly ctx: Context) {
    this.out = new Pose(ctx.skeleton.count);
  }

  /** Seconds of a cycle at the current rates (Infinity when stopped). */
  abstract duration(): number;
  /** Where it is in its cycle, from 0 to 1. */
  abstract phase(): number;
  abstract reset(): void;
  protected abstract doAdvance(dt: number, weight: number, emit: boolean): void;
  protected abstract doSetPhase(
    phase: number,
    weight: number,
    emit: boolean,
  ): void;
  protected abstract compute(): void;

  advance(dt: number, weight: number, emit: boolean): void {
    if (this._advanced !== this.ctx.frame) {
      this._advanced = this.ctx.frame;
      this.doAdvance(dt, weight, emit);
    }
  }

  // Moves forward to a phase: the synchronized blends.
  setPhase(phase: number, weight: number, emit: boolean): void {
    if (this._advanced !== this.ctx.frame) {
      this._advanced = this.ctx.frame;
      this.doSetPhase(phase, weight, emit);
    }
  }

  evaluate(): Pose {
    if (this._evaluated !== this.ctx.frame) {
      this._evaluated = this.ctx.frame;
      this.compute();
    }
    return this.out;
  }
}

class ClipNode extends RuntimeNode {
  private _time = 0;
  private readonly _base: Pose;

  constructor(
    ctx: Context,
    private readonly _clip: AnimationClip,
    private readonly _loop: boolean,
    private readonly _speed: number,
    private readonly _rate: NumberSource,
    additive: boolean,
  ) {
    super(ctx);
    // An additive clip is the difference with its first pose: the joints
    // without track add nothing.
    this._base = additive ? new Pose(ctx.skeleton.count) : ctx.skeleton.rest;
  }

  duration(): number {
    const rate = Math.abs(this._speed * this._rate());
    return rate > 0 && this._clip.duration > 0
      ? this._clip.duration / rate
      : Infinity;
  }

  phase(): number {
    return this._clip.duration > 0 ? this._time / this._clip.duration : 0;
  }

  reset(): void {
    this._time = 0;
  }

  protected doAdvance(dt: number, weight: number, emit: boolean): void {
    this.moveTo(this._time + dt * this._speed * this._rate(), weight, emit);
  }

  protected doSetPhase(phase: number, weight: number, emit: boolean): void {
    const length = this._clip.duration;
    if (!this._loop) {
      this.moveTo(Math.min(Math.max(phase, 0), 1) * length, weight, emit);
      return;
    }
    let target = (phase - Math.floor(phase)) * length;
    if (target < this._time) {
      // Forward, through the end of the cycle.
      target += length;
    }
    this.moveTo(target, weight, emit);
  }

  private moveTo(to: number, weight: number, emit: boolean): void {
    const clip = this._clip;
    const length = clip.duration;
    let from = this._time;
    const visit = (event: AnimationEvent) =>
      this.ctx.emit(event, clip.name, weight);
    if (!this._loop || length <= 0) {
      const time = Math.min(Math.max(to, 0), length);
      if (emit && time > from) {
        clip.eventsBetween(from, time, visit);
      }
      this._time = time;
      return;
    }
    if (to < from) {
      // Backwards: no event.
      this._time = ((to % length) + length) % length;
      return;
    }
    // Each end of the clip reached loops to its start: the events at 0
    // are reached from below it.
    let cycles = 0;
    while (to >= length && cycles < 8) {
      if (emit) {
        clip.eventsBetween(from, length, visit);
      }
      from = -1;
      to -= length;
      cycles++;
    }
    to = to % length;
    if (emit) {
      clip.eventsBetween(from, to, visit);
    }
    this._time = to;
  }

  protected compute(): void {
    this.out.copy(this._base);
    this._clip.sample(this._time, this.out);
  }
}

// The blends of two inputs at a time: anim.blend, and the two poses around
// the value of anim.blend1d. Synchronized, the inputs share the phase of
// the blend, which advances by the blended duration.
abstract class BlendBase extends RuntimeNode {
  private _phase = 0;
  protected a?: RuntimeNode;
  protected b?: RuntimeNode;
  protected weight = 0;

  constructor(
    ctx: Context,
    private readonly _sync: boolean,
  ) {
    super(ctx);
  }

  // Chooses a, b and the weight of b, from the inputs of the node.
  protected abstract choose(): void;
  abstract override reset(): void;

  private heavier(): RuntimeNode {
    return (this.weight >= 0.5 ? this.b : this.a) as RuntimeNode;
  }

  duration(): number {
    this.choose();
    if (!this._sync) {
      return this.heavier().duration();
    }
    const da = (this.a as RuntimeNode).duration();
    const db = (this.b as RuntimeNode).duration();
    if (this.weight <= 0) return da;
    if (this.weight >= 1) return db;
    return da * (1 - this.weight) + db * this.weight;
  }

  phase(): number {
    this.choose();
    return this._sync
      ? this._phase - Math.floor(this._phase)
      : this.heavier().phase();
  }

  protected resetPhase(): void {
    this._phase = 0;
  }

  protected doAdvance(dt: number, weight: number, emit: boolean): void {
    this.choose();
    if (this._sync) {
      const duration = this.duration();
      if (Number.isFinite(duration) && duration > 0) {
        this._phase += dt / duration;
      }
      this.propagatePhase(this._phase, weight, emit);
      return;
    }
    const w = this.weight;
    const a = this.a as RuntimeNode;
    const b = this.b as RuntimeNode;
    if (w < 1) a.advance(dt, weight * (1 - w), emit && w < 0.5);
    if (w > 0) b.advance(dt, weight * w, emit && w >= 0.5);
  }

  protected doSetPhase(phase: number, weight: number, emit: boolean): void {
    this.choose();
    this._phase = phase;
    this.propagatePhase(phase, weight, emit);
  }

  private propagatePhase(phase: number, weight: number, emit: boolean): void {
    const w = this.weight;
    const a = this.a as RuntimeNode;
    const b = this.b as RuntimeNode;
    if (w < 1) a.setPhase(phase, weight * (1 - w), emit && w < 0.5);
    if (w > 0) b.setPhase(phase, weight * w, emit && w >= 0.5);
  }

  protected compute(): void {
    this.choose();
    const a = this.a as RuntimeNode;
    const b = this.b as RuntimeNode;
    if (this.weight <= 0) {
      this.out.copy(a.evaluate());
    } else if (this.weight >= 1) {
      this.out.copy(b.evaluate());
    } else {
      Pose.blend(a.evaluate(), b.evaluate(), this.weight, this.out);
    }
  }
}

class BlendNode extends BlendBase {
  constructor(
    ctx: Context,
    sync: boolean,
    private readonly _inputs: readonly [RuntimeNode, RuntimeNode],
    private readonly _weight: NumberSource,
  ) {
    super(ctx, sync);
  }

  protected choose(): void {
    [this.a, this.b] = this._inputs;
    this.weight = Math.min(Math.max(this._weight(), 0), 1);
  }

  reset(): void {
    this.resetPhase();
    this._inputs.forEach((input) => input.reset());
  }
}

class Blend1dNode extends BlendBase {
  constructor(
    ctx: Context,
    sync: boolean,
    private readonly _inputs: readonly RuntimeNode[],
    private readonly _points: readonly number[],
    private readonly _value: NumberSource,
  ) {
    super(ctx, sync);
  }

  protected choose(): void {
    const points = this._points;
    const value = this._value();
    let i = 0;
    while (i < points.length - 2 && value > points[i + 1]) {
      i++;
    }
    this.a = this._inputs[i];
    this.b = this._inputs[i + 1];
    const span = points[i + 1] - points[i];
    this.weight = Math.min(Math.max((value - points[i]) / span, 0), 1);
  }

  reset(): void {
    this.resetPhase();
    this._inputs.forEach((input) => input.reset());
  }
}

class LayerNode extends RuntimeNode {
  constructor(
    ctx: Context,
    private readonly _base: RuntimeNode,
    private readonly _layer: RuntimeNode,
    private readonly _weight: NumberSource,
    private readonly _additive: boolean,
    private readonly _mask?: BoneMask,
  ) {
    super(ctx);
  }

  private weight(): number {
    return Math.min(Math.max(this._weight(), 0), 1);
  }

  duration(): number {
    return this._base.duration();
  }

  phase(): number {
    return this._base.phase();
  }

  reset(): void {
    this._base.reset();
    this._layer.reset();
  }

  // Both keep their events: the steps of the legs, the wave of the arm.
  protected doAdvance(dt: number, weight: number, emit: boolean): void {
    const w = this.weight();
    this._base.advance(dt, weight, emit);
    if (w > 0) this._layer.advance(dt, weight * w, emit);
  }

  protected doSetPhase(phase: number, weight: number, emit: boolean): void {
    const w = this.weight();
    this._base.setPhase(phase, weight, emit);
    if (w > 0) this._layer.setPhase(phase, weight * w, emit);
  }

  protected compute(): void {
    const w = this.weight();
    const base = this._base.evaluate();
    if (w <= 0) {
      this.out.copy(base);
      return;
    }
    const mask = this._mask?.weights;
    if (this._additive) {
      Pose.add(base, this._layer.evaluate(), w, this.out, mask);
    } else {
      Pose.blend(base, this._layer.evaluate(), w, this.out, mask);
    }
  }
}

interface RuntimeState {
  readonly name: string;
  readonly node: RuntimeNode;
  readonly resetOnEnter: boolean;
}

class StateMachineNode extends RuntimeNode {
  private _current: number;
  private _next = -1;
  private _elapsed = 0;
  private _fade = 0;
  private _time = 0;

  constructor(
    ctx: Context,
    private readonly _states: readonly RuntimeState[],
    private readonly _transitions: readonly TransitionDescription[],
    private readonly _initial: number,
    private readonly _parameters: Parameters,
  ) {
    super(ctx);
    this._current = _initial;
  }

  status(): StateMachineStatus {
    const next = this._next;
    return {
      state: this._states[this._current].name,
      ...(next >= 0 ? { next: this._states[next].name } : {}),
      progress: next >= 0 ? this.progress() : 0,
      time: this._time,
    };
  }

  private progress(): number {
    return this._fade > 0 ? Math.min(this._elapsed / this._fade, 1) : 1;
  }

  private heavier(): RuntimeNode {
    const state =
      this._next >= 0 && this.progress() >= 0.5 ? this._next : this._current;
    return this._states[state].node;
  }

  duration(): number {
    return this.heavier().duration();
  }

  phase(): number {
    return this.heavier().phase();
  }

  reset(): void {
    this._current = this._initial;
    this._next = -1;
    this._time = 0;
    this._states[this._current].node.reset();
  }

  private holds(condition: TransitionCondition): boolean {
    const value = this._parameters.get(condition.parameter);
    const expected = condition.value ?? true;
    // The order comparisons are for numbers (checked by the validation).
    const a = value as number;
    const b = expected as number;
    switch (condition.op ?? '==') {
      case '>':
        return a > b;
      case '>=':
        return a >= b;
      case '<':
        return a < b;
      case '<=':
        return a <= b;
      case '==':
        return value === expected;
      case '!=':
        return value !== expected;
    }
  }

  private findTransition(): TransitionDescription | undefined {
    const current = this._states[this._current];
    for (const transition of this._transitions) {
      if (
        (transition.from !== current.name &&
          !(transition.from === '*' && transition.to !== current.name)) ||
        (transition.trigger !== undefined &&
          this._parameters.get(transition.trigger) !== true) ||
        !(transition.conditions ?? []).every((c) => this.holds(c))
      ) {
        continue;
      }
      if (transition.exitTime !== undefined) {
        const duration = current.node.duration();
        const cycles = Number.isFinite(duration) ? this._time / duration : 0;
        if (cycles < transition.exitTime) {
          continue;
        }
      }
      return transition;
    }
    return undefined;
  }

  protected doAdvance(dt: number, weight: number, emit: boolean): void {
    if (this._next < 0) {
      const transition = this.findTransition();
      if (transition) {
        if (transition.trigger !== undefined) {
          this._parameters.set(transition.trigger, false);
        }
        const next = this._states.findIndex((s) => s.name === transition.to);
        if (this._states[next].resetOnEnter) {
          this._states[next].node.reset();
        }
        this._next = next;
        this._elapsed = 0;
        this._fade = transition.duration ?? 0.2;
        this._time = 0;
      }
    }
    if (this._next < 0) {
      this._time += dt;
      this._states[this._current].node.advance(dt, weight, emit);
      return;
    }
    this._elapsed += dt;
    this._time += dt;
    const w = this.progress();
    if (w < 1) {
      this._states[this._current].node.advance(
        dt,
        weight * (1 - w),
        emit && w < 0.5,
      );
    }
    this._states[this._next].node.advance(dt, weight * w, emit && w >= 0.5);
    if (w >= 1) {
      this._current = this._next;
      this._next = -1;
    }
  }

  protected doSetPhase(phase: number, weight: number, emit: boolean): void {
    const w = this._next >= 0 ? this.progress() : 0;
    this._states[this._current].node.setPhase(
      phase,
      weight * (1 - w),
      emit && w < 0.5,
    );
    if (this._next >= 0) {
      this._states[this._next].node.setPhase(
        phase,
        weight * w,
        emit && w >= 0.5,
      );
    }
  }

  protected compute(): void {
    const current = this._states[this._current].node.evaluate();
    if (this._next < 0) {
      this.out.copy(current);
      return;
    }
    Pose.blend(
      current,
      this._states[this._next].node.evaluate(),
      this.progress(),
      this.out,
    );
  }
}

// The values of the parameters, by name.
class Parameters {
  private readonly _values = new Map<string, number | boolean>();
  private readonly _types = new Map<string, string>();

  constructor(graph: AnimationGraphData) {
    for (const parameter of graph.parameters ?? []) {
      this._types.set(parameter.name, parameter.type);
      this._values.set(
        parameter.name,
        parameter.default ?? (parameter.type === 'number' ? 0 : false),
      );
    }
  }

  type(name: string): string {
    const type = this._types.get(name);
    if (!type) {
      throw new Error(`The animation graph has no parameter "${name}"`);
    }
    return type;
  }

  get(name: string): number | boolean {
    this.type(name);
    return this._values.get(name) as number | boolean;
  }

  set(name: string, value: number | boolean): void {
    const type = this.type(name);
    if ((type === 'number') !== (typeof value === 'number')) {
      throw new Error(
        `Parameter "${name}" is a ${type}, not a ${typeof value}`,
      );
    }
    this._values.set(name, value);
  }
}

/**
 * Runs an animation graph for a character: its parameters, the time of its
 * clips, its state machines; each update gives a pose of the skeleton and
 * the events reached. One animator per character; the graph, the clips and
 * the masks are shared.
 *
 * Event rule: a blend or a cross-fade keeps the events of its heavier
 * input (one footstep, not one per blended clip), a layer those of both.
 *
 * @example
 * ```ts
 * const animator = new Animator(graph, { skeleton, clips, masks });
 * animator.set('speed', 3);
 * animator.trigger('jump');
 * const pose = animator.update(dt);
 * for (const event of animator.events) play(event.name);
 * ```
 *
 * @group Animator
 */
export class Animator {
  /** The pose of the last update (the rest pose before the first). */
  readonly pose: Pose;
  readonly skeleton: Skeleton;
  private readonly _events: FiredEvent[] = [];
  private readonly _listeners = new Set<(event: FiredEvent) => void>();
  private readonly _parameters: Parameters;
  private readonly _root: RuntimeNode;
  private readonly _machines = new Map<string, StateMachineNode>();
  private readonly _ctx: Context;

  /** @throws {@link GraphError} when the graph is invalid, Error when a clip or a mask is missing. */
  constructor(graph: AnimationGraphData, options: AnimatorOptions) {
    const validation = validateAnimationGraph(
      graph,
      options.registry ?? createAnimationRegistry(),
    );
    if (!validation.valid) {
      throw new GraphError(validation.diagnostics);
    }
    this.skeleton = options.skeleton;
    this.pose = options.skeleton.rest.clone();
    this._parameters = new Parameters(graph);
    const clips = new Map<string, AnimationClip>(
      Array.isArray(options.clips)
        ? (options.clips as readonly AnimationClip[]).map((clip) => [
            clip.name,
            clip,
          ])
        : Object.entries(options.clips),
    );
    const additives = new Map<AnimationClip, AnimationClip>();
    const events = this._events;
    const listeners = this._listeners;
    this._ctx = {
      skeleton: options.skeleton,
      frame: 0,
      emit(event, clip, weight) {
        const fired = { ...event, clip, weight };
        events.push(fired);
        listeners.forEach((listener) => listener(fired));
      },
    };

    const { nodes, incoming } = validation;
    const runtimes = new Map<string, RuntimeNode>();
    const source = (id: string, port: string) =>
      incoming.get(id)?.find((edge) => edge.to.port === port)?.from.node;
    const number = (id: string, port: string): NumberSource => {
      const from = source(id, port);
      if (from !== undefined) {
        const name = nodes.get(from)?.params['name'] as string;
        return () => this._parameters.get(name) as number;
      }
      const resolved = nodes.get(id);
      const value =
        resolved?.node.defaults?.[port] ??
        (resolved?.inputs.find((input) => input.name === port)
          ?.default as number);
      return () => value as number;
    };
    const build = (id: string): RuntimeNode => {
      const existing = runtimes.get(id);
      if (existing) {
        return existing;
      }
      const resolved = nodes.get(id);
      if (!resolved) {
        throw new Error(`Unknown node "${id}"`);
      }
      const { params } = resolved;
      const pose = (port: string) => build(source(id, port) as string);
      let runtime: RuntimeNode;
      switch (resolved.node.type) {
        case 'anim.clip': {
          const name = params['clip'] as string;
          let clip = clips.get(name);
          if (!clip) {
            throw new Error(`The animator has no clip "${name}"`);
          }
          if (params['additive']) {
            let additive = additives.get(clip);
            if (!additive) {
              additive = additiveClip(clip, options.skeleton);
              additives.set(clip, additive);
            }
            clip = additive;
          }
          runtime = new ClipNode(
            this._ctx,
            clip,
            params['loop'] as boolean,
            params['speed'] as number,
            number(id, 'rate'),
            params['additive'] as boolean,
          );
          break;
        }
        case 'anim.blend':
          runtime = new BlendNode(
            this._ctx,
            params['sync'] as boolean,
            [pose('a'), pose('b')],
            number(id, 'weight'),
          );
          break;
        case 'anim.blend1d': {
          const points = params['points'] as number[];
          runtime = new Blend1dNode(
            this._ctx,
            params['sync'] as boolean,
            points.map((_, i) => pose(`pose${i}`)),
            points,
            number(id, 'value'),
          );
          break;
        }
        case 'anim.layer': {
          const name = params['mask'] as string | undefined;
          const mask = name !== undefined ? options.masks?.[name] : undefined;
          if (name !== undefined && !mask) {
            throw new Error(`The animator has no mask "${name}"`);
          }
          runtime = new LayerNode(
            this._ctx,
            pose('base'),
            pose('layer'),
            number(id, 'weight'),
            params['mode'] === 'additive',
            mask,
          );
          break;
        }
        case 'anim.stateMachine': {
          const states = statesOf(params).map((state) => ({
            name: state.name,
            node: pose(state.name),
            resetOnEnter: state.resetOnEnter ?? true,
          }));
          const initial = params['initial'] as string | undefined;
          const machine = new StateMachineNode(
            this._ctx,
            states,
            transitionsOf(params),
            initial === undefined
              ? 0
              : states.findIndex((state) => state.name === initial),
            this._parameters,
          );
          this._machines.set(id, machine);
          if (resolved.node.label !== undefined) {
            this._machines.set(resolved.node.label, machine);
          }
          runtime = machine;
          break;
        }
        default:
          throw new Error(
            `The animator cannot run "${resolved.node.type}" nodes`,
          );
      }
      runtimes.set(id, runtime);
      return runtime;
    };
    const output = [...nodes.values()].find(
      (resolved) => resolved.node.type === 'anim.output',
    );
    this._root = build(source(output?.node.id as string, 'pose') as string);
  }

  /** The events reached by the last update, in order. */
  get events(): readonly FiredEvent[] {
    return this._events;
  }

  /** Calls `listener` for each event reached; returns the function that unsubscribes. */
  onEvent(listener: (event: FiredEvent) => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /** Sets a number or boolean parameter. */
  set(name: string, value: number | boolean): this {
    this._parameters.set(name, value);
    return this;
  }

  get(name: string): number | boolean {
    return this._parameters.get(name);
  }

  /** Sets a trigger: the next transition it allows consumes it. */
  trigger(name: string): this {
    if (this._parameters.type(name) !== 'trigger') {
      throw new Error(`Parameter "${name}" is not a trigger`);
    }
    this._parameters.set(name, true);
    return this;
  }

  /** Where a state machine is, by its label or its node id. */
  state(machine: string): StateMachineStatus | undefined {
    return this._machines.get(machine)?.status();
  }

  /** Back to the start: the initial states, the clips at 0. */
  reset(): this {
    this._root.reset();
    this.pose.copy(this.skeleton.rest);
    return this;
  }

  /**
   * Advances the graph by `dt` seconds: the transitions, the time of the
   * clips, the events reached; returns the new pose.
   */
  update(dt: number): Pose {
    this._events.length = 0;
    this._ctx.frame++;
    this._root.advance(dt, 1, true);
    this.pose.copy(this._root.evaluate());
    return this.pose;
  }
}
