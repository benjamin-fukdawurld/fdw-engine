import type { NodeId } from '@fdw/engine-graph';
import type { BehaviorInstance } from './BehaviorInstance';
import type { BehaviorSystem } from './BehaviorSystem';
import type { Interpreter } from './Interpreter';
import type { BehaviorNodeKind } from './nodes';
import type { ProgramNode } from './program';

/**
 * Where and why the debugger stopped a graph.
 *
 * @group Debugging
 */
export interface BehaviorPause<H = unknown> {
  readonly instance: BehaviorInstance<H>;
  /** The node about to run. */
  readonly node: NodeId;
  readonly reason: 'breakpoint' | 'step';
}

/**
 * The state of a node of an instance: what an editor shows over it.
 *
 * @group Debugging
 */
export interface NodeState {
  readonly id: NodeId;
  readonly type: string;
  readonly label: string;
  readonly kind: BehaviorNodeKind;
  /** How many times it ran (or was evaluated, for a pure node). */
  readonly runs: number;
  /** The time of the instance at its last run; -1 before. */
  readonly time: number;
  /** The values of its data outputs at its last run. */
  readonly outputs: Readonly<Record<string, unknown>>;
  /** Whether it ran during the last run of the system. */
  readonly active: boolean;
  /** Whether a breakpoint is on it. */
  readonly breakpoint: boolean;
  /** A `flow.delay` that waits. */
  readonly waiting: boolean;
}

/** @internal What the system lets its debugger do. */
export interface DebuggerControls<H> {
  resume(instance: BehaviorInstance<H>): void;
  close(): void;
}

/**
 * The debugger of a {@link BehaviorSystem} (`system.debug()`): breakpoints
 * on the nodes of the flow, stepping from node to node, the state of each
 * node of an instance and the trace of what ran. The system interprets its
 * graph while the debugger is open; while it is paused, the system does not
 * run (the rest of the game goes on, unless the application pauses it in
 * `onPause`).
 *
 * @example
 * ```ts
 * const debug = system.debug();
 * debug.entity = orc; // only this one stops
 * debug.addBreakpoint('attack');
 * debug.onPause(({ node }) => (scheduler.paused = true));
 * // …later, from the UI:
 * debug.states(orc); // runs, outputs, active, waiting…
 * debug.step();
 * debug.continue();
 * ```
 *
 * @group Debugging
 */
export class BehaviorDebugger<H = unknown> {
  /** Only the instance of this entity stops; all of them when undefined. */
  entity: number | undefined;
  private readonly _breakpoints = new Set<NodeId>();
  private readonly _listeners: ((pause: BehaviorPause<H>) => void)[] = [];
  private _paused: BehaviorPause<H> | undefined;
  private _stepping = false;

  constructor(
    readonly system: BehaviorSystem<H>,
    interpreter: Interpreter<H>,
    private readonly _controls: DebuggerControls<H>,
  ) {
    interpreter.hooks = {
      shouldBreak: (instance, node) =>
        (this.entity === undefined || this.entity === instance.entity) &&
        (this._stepping || this._breakpoints.has(node.id)),
      pause: (instance, node) => this.pause(instance, node),
    };
  }

  /** The nodes with a breakpoint. */
  get breakpoints(): ReadonlySet<NodeId> {
    return this._breakpoints;
  }

  /**
   * Stops before a node runs: an event, an action or a node of the flow.
   *
   * @throws for an unknown node, or a pure node (evaluated inside the node
   * reading it, it has no moment of its own).
   */
  addBreakpoint(node: NodeId): this {
    const index = this.system.program.byId.get(node);
    if (index === undefined) {
      throw new Error(`No node "${node}" in "${this.system.graph.name}"`);
    }
    if (this.system.program.nodes[index].kind === 'pure') {
      throw new Error(
        `Node "${node}" is pure: break on a node of the flow that reads it`,
      );
    }
    this._breakpoints.add(node);
    return this;
  }

  removeBreakpoint(node: NodeId): this {
    this._breakpoints.delete(node);
    return this;
  }

  /** Adds or removes a breakpoint; returns whether there is one now. */
  toggleBreakpoint(node: NodeId): boolean {
    if (this._breakpoints.has(node)) {
      this._breakpoints.delete(node);
      return false;
    }
    this.addBreakpoint(node);
    return true;
  }

  clearBreakpoints(): this {
    this._breakpoints.clear();
    return this;
  }

  /** Where the graph stopped, if it did. */
  get paused(): BehaviorPause<H> | undefined {
    return this._paused;
  }

  /** Calls `listener` when the graph stops. Returns a function removing it. */
  onPause(listener: (pause: BehaviorPause<H>) => void): () => void {
    this._listeners.push(listener);
    return () => {
      const index = this._listeners.indexOf(listener);
      if (index >= 0) {
        this._listeners.splice(index, 1);
      }
    };
  }

  /** Goes on until the next breakpoint. */
  continue(): void {
    this._stepping = false;
    this.resume();
  }

  /**
   * Runs the node the graph stopped before, and stops before the next one,
   * in this chain or the next one to run. Not paused, stops before the next
   * node to run.
   */
  step(): void {
    this._stepping = true;
    this.resume();
  }

  /** The states of the nodes of the instance of an entity, in the order of the graph. */
  states(entity: number): NodeState[] {
    const instance = this.require(entity);
    const active = new Set(instance.trace ?? []);
    return this.system.program.nodes.map((node: ProgramNode) => {
      const call = instance.calls[node.index];
      return {
        id: node.id,
        type: node.node.type,
        label: node.label,
        kind: node.kind,
        runs: call.runs,
        time: call.time,
        outputs: { ...call.outputs },
        active: active.has(node.id),
        breakpoint: this._breakpoints.has(node.id),
        waiting: call.state['pending'] === true,
      };
    });
  }

  /** The state of a node of the instance of an entity. */
  state(entity: number, node: NodeId): NodeState | undefined {
    return this.states(entity).find((state) => state.id === node);
  }

  /**
   * The nodes of the flow the instance of an entity ran during the last run
   * of the system (and the events handled after it), in order.
   */
  trace(entity: number): readonly NodeId[] {
    return [...(this.require(entity).trace ?? [])];
  }

  /**
   * Closes the debugger: no breakpoint, the graph resumed if paused, the
   * system back to its mode.
   */
  close(): void {
    this._breakpoints.clear();
    this.continue();
    this._controls.close();
  }

  /** @internal The system forgets an instance. */
  detached(instance: BehaviorInstance<H>): void {
    if (this._paused?.instance === instance) {
      this._paused = undefined;
    }
  }

  private resume(): void {
    const paused = this._paused;
    if (!paused) {
      return;
    }
    this._paused = undefined;
    this._controls.resume(paused.instance);
  }

  private pause(instance: BehaviorInstance<H>, node: ProgramNode): void {
    const pause: BehaviorPause<H> = {
      instance,
      node: node.id,
      reason: this._stepping ? 'step' : 'breakpoint',
    };
    this._stepping = false;
    this._paused = pause;
    for (const listener of [...this._listeners]) {
      listener(pause);
    }
  }

  private require(entity: number): BehaviorInstance<H> {
    const instance = this.system.instance(entity);
    if (!instance) {
      throw new Error(`Entity ${entity} has no instance of the graph`);
    }
    return instance;
  }
}
