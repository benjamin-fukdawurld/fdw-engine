import type { NodeId } from '@fdw/engine-graph';
import { type BehaviorValue, isOfType, zeroOf } from './data';
import type { BehaviorContext, NodeCall } from './nodes';
import type { BehaviorProgram } from './program';

/**
 * A continuation of the interpreter: a node to enter by one of its exec
 * inputs, an event node to start with its payload, or a loop to go on.
 *
 * @internal
 */
export interface Frame {
  readonly node: number;
  /** The exec input; -1 for an event, -2 for the next turn of a loop. */
  readonly entry: number;
  readonly payload?: Readonly<Record<string, unknown>>;
}

/** @internal */
export const EventEntry = -1;
/** @internal */
export const LoopEntry = -2;

/**
 * A `flow.delay` waiting: the node to wake at a time of the instance.
 *
 * @internal
 */
export interface Timer {
  readonly at: number;
  readonly node: number;
}

/**
 * What the system gives its instances.
 *
 * @internal
 */
export interface InstanceHost<H> {
  readonly host: H;
  readonly maxSteps: number;
  random(): number;
  log(text: string, instance: BehaviorInstance<H>): void;
  emit(
    target: number,
    event: string,
    payload: Readonly<Record<string, unknown>>,
  ): void;
}

/**
 * The run of a behavior graph for an entity: its variables, the state of
 * its nodes (the outputs of the last run of each, what they keep), its
 * clock and the delays it waits for. Made by {@link BehaviorSystem.attach};
 * both executors, the interpreter and the compiled code, run the same
 * instance: the system can switch from one to the other.
 *
 * @group Execution
 */
export class BehaviorInstance<H = unknown> implements BehaviorContext<H> {
  readonly variables: Record<string, BehaviorValue> = {};
  /** The nodes of the graph, for this instance, in the order of the program. */
  readonly calls: readonly NodeCall<H>[];
  /** Seconds since the instance started. */
  time = 0;
  /** Whether `event.start` ran. */
  started = false;
  /** Set when detached: the chain running stops at the next node. */
  stopped = false;

  /** @internal The nodes run in the current chain, against `maxSteps`. */
  steps = 0;
  /** @internal */
  readonly maxSteps: number;
  /** @internal The continuations of the interpreter: kept when it pauses. */
  readonly stack: Frame[] = [];
  /** @internal The interpreter resumes after a pause: no break on the first node. */
  resumed = false;
  /** @internal The pure values of the current node: their evaluation count. */
  epoch = 0;
  /** @internal The epoch of the last evaluation of each pure node. */
  readonly epochs: Int32Array;
  /** @internal The delays waiting, by time. */
  readonly timers: Timer[] = [];
  /** @internal The events sent while a chain runs, handled after it. */
  readonly queue: {
    event: string;
    payload: Readonly<Record<string, unknown>>;
  }[] = [];
  /** @internal The nodes run during the last run of the system, when debugged. */
  trace: NodeId[] | undefined;

  constructor(
    readonly program: BehaviorProgram,
    readonly entity: number,
    private readonly _system: InstanceHost<H>,
    variables: Readonly<Record<string, BehaviorValue>> = {},
  ) {
    this.maxSteps = _system.maxSteps;
    for (const variable of program.variables) {
      this.variables[variable.name] = variable.default ?? zeroOf(variable.type);
    }
    for (const [name, value] of Object.entries(variables)) {
      this.set(name, value);
    }
    this.calls = program.nodes.map((node): NodeCall<H> => ({
      self: this,
      id: node.id,
      params: node.params,
      outputs: {},
      state: {},
      runs: 0,
      time: -1,
    }));
    this.epochs = new Int32Array(program.nodes.length).fill(-1);
  }

  get host(): H {
    return this._system.host;
  }

  /** The value of a variable. */
  get(name: string): BehaviorValue {
    if (!(name in this.variables)) {
      throw new Error(`Unknown variable "${name}"`);
    }
    return this.variables[name];
  }

  /**
   * Sets a variable.
   *
   * @throws when the graph has no such variable, or the value is not of its type.
   */
  set(name: string, value: BehaviorValue): this {
    const variable = this.program.variables.find((v) => v.name === name);
    if (!variable) {
      throw new Error(`Unknown variable "${name}"`);
    }
    if (!isOfType(value, variable.type)) {
      throw new Error(
        `Variable "${name}" is a ${variable.type}, not ${JSON.stringify(value)}`,
      );
    }
    this.variables[name] = value;
    return this;
  }

  random(): number {
    return this._system.random();
  }

  emit(
    event: string,
    payload: Readonly<Record<string, unknown>> = {},
    target: number = this.entity,
  ): void {
    this._system.emit(target, event, payload);
  }

  log(text: string): void {
    this._system.log(text, this);
  }

  /** @internal Wakes a `flow.delay` node after some seconds. */
  wait(seconds: number, node: number): void {
    const timer = { at: this.time + Math.max(0, seconds), node };
    // Sorted by time, the first added first among equals.
    let i = this.timers.length;
    while (i > 0 && this.timers[i - 1].at > timer.at) {
      i--;
    }
    this.timers.splice(i, 0, timer);
  }
}
