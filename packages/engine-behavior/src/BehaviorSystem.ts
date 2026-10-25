import type { Registry } from '@fdw/engine-graph';
import { BehaviorDebugger } from './BehaviorDebugger';
import {
  BehaviorInstance,
  type InstanceHost,
  type Timer,
} from './BehaviorInstance';
import { CompiledBehavior } from './compile';
import type { BehaviorGraphData, BehaviorValue } from './data';
import { type BehaviorExecutor, Interpreter } from './Interpreter';
import type { BehaviorNodeType } from './nodes';
import { type BehaviorProgram, prepareBehavior } from './program';

/**
 * How a system runs its graph: walked node by node (`interpret`: the
 * debugger's breakpoints and node states), or compiled to JavaScript
 * (`compile`: faster).
 *
 * @group Execution
 */
export type BehaviorMode = 'interpret' | 'compile';

/**
 * Options of a {@link BehaviorSystem}.
 *
 * @typeParam H - What the nodes of the application receive: the game.
 *
 * @group Execution
 */
export interface BehaviorSystemOptions<H> {
  /** What the nodes reach as `call.self.host`. */
  readonly host: H;
  /** The node types: the standard ones and those of the application. */
  readonly registry?: Registry<BehaviorNodeType>;
  /**
   * `compile` by default; `interpret` where `new Function` is forbidden
   * (the system falls back to it by itself).
   */
  readonly mode?: BehaviorMode;
  /**
   * The most nodes a chain runs before the system gives up with a
   * {@link BehaviorError} (a loop of the flow that never ends). Default
   * 1000.
   */
  readonly maxSteps?: number;
  /** The random source of `math.random`; `Math.random` by default. */
  readonly random?: () => number;
  /** Where `debug.log` writes; the console by default. */
  readonly log?: (text: string, instance: BehaviorInstance<H>) => void;
}

/**
 * The parts of a scheduler a system installs itself in: the `Scheduler` of
 * `@fdw/engine-scene`, without depending on it.
 *
 * @group Execution
 */
export interface SchedulerLike {
  add(
    name: string,
    run: (dt: number) => void,
    options?: {
      readonly phase?: 'begin' | 'fixed' | 'update' | 'render';
      readonly before?: readonly string[];
      readonly after?: readonly string[];
    },
  ): unknown;
  remove(name: string): boolean;
}

/**
 * Options of {@link BehaviorSystem.install}.
 *
 * @group Execution
 */
export interface BehaviorInstallOptions {
  /** The name of the system; the name of the graph by default. */
  readonly name?: string;
  /** `fixed` by default: the logic of a game, at each fixed step. */
  readonly phase?: 'begin' | 'fixed' | 'update' | 'render';
  readonly before?: readonly string[];
  readonly after?: readonly string[];
}

/**
 * A behavior graph as a system: an instance of the graph per entity
 * attached, run together at each run of the system. A run starts the new
 * instances (`event.start`), advances their clocks, wakes their delays,
 * then runs `event.update`; the events sent by the application or by the
 * graphs are handled as soon as no chain runs.
 *
 * @example
 * ```ts
 * const system = new BehaviorSystem(graph, { host: game, registry });
 * system.attach(orc, { health: 60 });
 * system.install(scheduler, { after: ['hero'] });
 * system.emit(orc, 'hit', { damage: 20 });
 * ```
 *
 * @group Execution
 */
export class BehaviorSystem<H = unknown> {
  private _program: BehaviorProgram;
  private readonly _registry: Registry<BehaviorNodeType> | undefined;
  private _instances = new Map<number, BehaviorInstance<H>>();
  private readonly _host: InstanceHost<H>;
  private _interpreter: Interpreter<H>;
  private _compiled: CompiledBehavior<H> | undefined;
  private _executor: BehaviorExecutor<H>;
  private _mode: BehaviorMode;
  // How many chains run now: the events sent meanwhile wait.
  private _depth = 0;
  // The instances, in an array for the runs.
  private _list: BehaviorInstance<H>[] | undefined;
  // The instances with events waiting.
  private readonly _waiting = new Set<BehaviorInstance<H>>();
  private _debugger: BehaviorDebugger<H> | undefined;
  // The mode to go back to when the debugger closes.
  private _modeBeforeDebug: BehaviorMode = 'compile';

  constructor(graph: BehaviorGraphData, options: BehaviorSystemOptions<H>) {
    this._registry = options.registry;
    this._program = prepareBehavior(graph, options.registry);
    const log =
      options.log ??
      ((text: string, instance: BehaviorInstance<H>) =>
        console.log(`[${graph.name} #${instance.entity}] ${text}`));
    this._host = {
      host: options.host,
      maxSteps: options.maxSteps ?? 1000,
      random: options.random ?? Math.random,
      log,
      emit: (target, event, payload) => this.emit(target, event, payload),
    };
    this._interpreter = new Interpreter(this.program);
    this._executor = this._interpreter;
    this._mode = 'interpret';
    this.mode = options.mode ?? 'compile';
  }

  /** The graph run, validated and resolved. */
  get program(): BehaviorProgram {
    return this._program;
  }

  /** The graph run. */
  get graph(): BehaviorGraphData {
    return this._program.graph;
  }

  /**
   * Runs another graph from now on: an edited graph, live. Each instance
   * keeps its entity, its clock, the events it waits to handle, and the
   * values of its variables the new graph declares with the same type (the
   * others take their default); its nodes start again (counters, delays
   * waiting, a `flow.doOnce` done). Paused by the debugger, the graph
   * resumes; the breakpoints on nodes of the new graph stay.
   *
   * @throws {@link GraphError} when the graph has errors: the system goes
   * on with its graph.
   */
  setGraph(graph: BehaviorGraphData): void {
    const program = prepareBehavior(graph, this._registry);
    const interpreter = new Interpreter<H>(program);
    interpreter.hooks = this._interpreter.hooks;
    const previous = this._instances;
    this._debugger?.replaced(previous.values(), program);
    this._program = program;
    this._interpreter = interpreter;
    this._compiled = undefined;
    this._instances = new Map();
    this._waiting.clear();
    this._list = undefined;
    for (const [entity, old] of previous) {
      const kept: Record<string, BehaviorValue> = {};
      for (const variable of program.variables) {
        const before = old.program.variables.find(
          (v) => v.name === variable.name,
        );
        if (before?.type === variable.type) {
          kept[variable.name] = old.variables[variable.name];
        }
      }
      const instance = new BehaviorInstance(program, entity, this._host, kept);
      instance.time = old.time;
      instance.started = old.started;
      instance.queue.push(...old.queue);
      if (this._debugger) instance.trace = [];
      this._instances.set(entity, instance);
      if (instance.queue.length > 0) this._waiting.add(instance);
      old.stopped = true;
    }
    if (this._debugger) {
      this._executor = interpreter;
    } else {
      this.mode = this._mode;
    }
  }

  /**
   * How the graph runs. Where `new Function` is forbidden, `compile`
   * leaves the system on `interpret`. Switching keeps the instances, their
   * variables and their delays. While the debugger is open, the system
   * interprets: the mode set applies when it closes.
   */
  get mode(): BehaviorMode {
    return this._mode;
  }

  set mode(mode: BehaviorMode) {
    if (this._debugger) {
      this._modeBeforeDebug = mode;
      return;
    }
    if (mode === 'compile') {
      try {
        this._compiled ??= new CompiledBehavior(this.program);
        this._executor = this._compiled;
        this._mode = 'compile';
        return;
      } catch (error) {
        if (!(error instanceof EvalError)) {
          throw error;
        }
      }
    }
    this._executor = this._interpreter;
    this._mode = 'interpret';
  }

  /** The graph compiled to JavaScript, once the system compiled it. */
  get compiled(): CompiledBehavior<H> | undefined {
    return this._compiled;
  }

  /** The instances, in the order they were attached. */
  get instances(): IterableIterator<BehaviorInstance<H>> {
    return this._instances.values();
  }

  get size(): number {
    return this._instances.size;
  }

  /** The instance of an entity. */
  instance(entity: number): BehaviorInstance<H> | undefined {
    return this._instances.get(entity);
  }

  /**
   * Runs the graph for an entity, from the next run of the system, with
   * values for some of its variables.
   *
   * @throws when the entity has an instance already, or a value is not of
   * its variable's type.
   */
  attach(
    entity: number,
    variables: Readonly<Record<string, BehaviorValue>> = {},
  ): BehaviorInstance<H> {
    if (this._instances.has(entity)) {
      throw new Error(`Entity ${entity} runs "${this.graph.name}" already`);
    }
    const instance = new BehaviorInstance(
      this.program,
      entity,
      this._host,
      variables,
    );
    if (this._debugger) {
      instance.trace = [];
    }
    this._instances.set(entity, instance);
    this._list = undefined;
    return instance;
  }

  /**
   * Stops running the graph for an entity: the chain running, if any,
   * stops at its next node. Returns whether it had an instance.
   */
  detach(entity: number): boolean {
    const instance = this._instances.get(entity);
    if (!instance) {
      return false;
    }
    instance.stopped = true;
    instance.stack.length = 0;
    this._instances.delete(entity);
    this._list = undefined;
    this._waiting.delete(instance);
    this._debugger?.detached(instance);
    return true;
  }

  /**
   * Sends an event to the instance of an entity, with its fields: handled
   * at once, or as soon as the chain running ends (and after a pause of the
   * debugger). Without an instance, nothing happens.
   */
  emit(
    entity: number,
    event: string,
    payload: Readonly<Record<string, unknown>> = {},
  ): void {
    const instance = this._instances.get(entity);
    if (!instance) {
      return;
    }
    instance.queue.push({ event, payload });
    this._waiting.add(instance);
    if (this._depth === 0) {
      this.flush();
    }
  }

  /**
   * Runs the graph for every instance: the system. `dt`: the time of the
   * step, in seconds. Does nothing while the debugger is paused.
   */
  run(dt: number): void {
    if (this._debugger?.paused) {
      return;
    }
    const payload = { dt };
    const executor = this._executor;
    this._list ??= [...this._instances.values()];
    this._depth++;
    try {
      for (const instance of this._list) {
        if (instance.stopped) {
          continue;
        }
        if (instance.trace) {
          instance.trace.length = 0;
        }
        if (!instance.started) {
          instance.started = true;
          executor.dispatch(instance, 'start', payload);
          if (this._debugger?.paused) return;
        }
        instance.time += dt;
        const timers = instance.timers;
        while (timers.length > 0 && timers[0].at <= instance.time) {
          executor.wake(instance, (timers.shift() as Timer).node);
          if (this._debugger?.paused) return;
        }
        executor.dispatch(instance, 'update', payload);
        if (this._debugger?.paused) return;
      }
    } finally {
      this._depth--;
    }
    this.flush();
  }

  /**
   * Installs the system in a scheduler (the `Scheduler` of
   * `@fdw/engine-scene`): in the `fixed` phase by default, named after the
   * graph. Returns a function removing it.
   */
  install(
    scheduler: SchedulerLike,
    options: BehaviorInstallOptions = {},
  ): () => void {
    const name = options.name ?? this.graph.name;
    scheduler.add(name, (dt) => this.run(dt), {
      phase: options.phase ?? 'fixed',
      ...(options.before ? { before: options.before } : {}),
      ...(options.after ? { after: options.after } : {}),
    });
    return () => {
      scheduler.remove(name);
    };
  }

  /**
   * The debugger of the system, made on first use: the system interprets
   * its graph from then on, until the debugger is closed.
   */
  debug(): BehaviorDebugger<H> {
    if (!this._debugger) {
      this._debugger = new BehaviorDebugger(this, this._interpreter, {
        resume: (instance) => {
          if (this.chain(() => this._interpreter.resume(instance))) {
            this.flush();
          }
        },
        close: () => {
          this._interpreter.hooks = undefined;
          this._debugger = undefined;
          for (const instance of this._instances.values()) {
            instance.trace = undefined;
          }
          this.mode = this._modeBeforeDebug;
        },
      });
      this._modeBeforeDebug = this._mode;
      this._executor = this._interpreter;
      this._mode = 'interpret';
      for (const instance of this._instances.values()) {
        instance.trace = [];
      }
    }
    return this._debugger;
  }

  // Runs a chain; false when the debugger paused it.
  private chain(run: () => void): boolean {
    this._depth++;
    try {
      run();
    } finally {
      this._depth--;
    }
    return !this._debugger?.paused;
  }

  // Handles the events waiting, those they send included.
  private flush(): void {
    let budget = 10_000;
    while (this._waiting.size > 0 && !this._debugger?.paused) {
      const instance = this._waiting.values().next()
        .value as BehaviorInstance<H>;
      const next = instance.queue.shift();
      if (!next) {
        this._waiting.delete(instance);
        continue;
      }
      if (--budget < 0) {
        throw new Error(
          `Behavior graph "${this.graph.name}": events keep sending events`,
        );
      }
      this.chain(() =>
        this._executor.dispatch(instance, next.event, next.payload),
      );
    }
  }
}
