import {
  type BehaviorInstance,
  EventEntry,
  type Frame,
  LoopEntry,
} from './BehaviorInstance';
import {
  BehaviorError,
  type BehaviorProgram,
  type DataSource,
  type ExecTarget,
  type ProgramNode,
} from './program';

/**
 * Runs the chains of a program for an instance: what the interpreter and
 * the compiled code both do.
 *
 * @group Execution
 */
export interface BehaviorExecutor<H = unknown> {
  /** Runs the handlers of an event, its payload in their outputs. */
  dispatch(
    instance: BehaviorInstance<H>,
    event: string,
    payload: Readonly<Record<string, unknown>>,
  ): void;
  /** Goes on after a `flow.delay` that waited. */
  wake(instance: BehaviorInstance<H>, node: number): void;
}

/**
 * Where the interpreter stops: the debugger.
 *
 * @internal
 */
export interface BreakHooks<H> {
  shouldBreak(instance: BehaviorInstance<H>, node: ProgramNode): boolean;
  pause(instance: BehaviorInstance<H>, node: ProgramNode): void;
}

/**
 * The interpreter: walks the nodes of the program, one at a time, its
 * continuations on a stack of the instance. It can stop before any node (a
 * breakpoint, a step of the debugger) and resume later where it stopped;
 * it records the outputs of every node, pure ones included, for the
 * debugger.
 *
 * @group Execution
 */
export class Interpreter<H = unknown> implements BehaviorExecutor<H> {
  /** Where to stop; none by default. */
  hooks: BreakHooks<H> | undefined;
  // The arguments of each node, reused: the call, then the inputs.
  private readonly _args: unknown[][];

  constructor(readonly program: BehaviorProgram) {
    this._args = program.nodes.map((node) =>
      new Array<unknown>(node.inputs.length + 1).fill(undefined),
    );
  }

  dispatch(
    instance: BehaviorInstance<H>,
    event: string,
    payload: Readonly<Record<string, unknown>>,
  ): void {
    const handlers = this.program.handlers.get(event);
    if (!handlers) {
      return;
    }
    for (let i = handlers.length - 1; i >= 0; i--) {
      instance.stack.push({ node: handlers[i], entry: EventEntry, payload });
    }
    this.loop(instance);
  }

  wake(instance: BehaviorInstance<H>, node: number): void {
    instance.calls[node].state['pending'] = false;
    this.push(instance, this.program.nodes[node].exits[0]);
    this.loop(instance);
  }

  /** Goes on after a pause, from the node it stopped before. */
  resume(instance: BehaviorInstance<H>): void {
    instance.resumed = true;
    this.loop(instance);
  }

  /** Whether the instance has a chain waiting to resume. */
  isSuspended(instance: BehaviorInstance<H>): boolean {
    return instance.stack.length > 0;
  }

  // Runs the stack of the instance; an error empties it: the next event
  // starts afresh.
  private loop(instance: BehaviorInstance<H>): void {
    try {
      this.walk(instance);
    } catch (error) {
      instance.stack.length = 0;
      throw error;
    }
  }

  private walk(instance: BehaviorInstance<H>): void {
    const { stack, calls } = instance;
    const nodes = this.program.nodes;
    instance.steps = 0;
    while (stack.length > 0) {
      if (instance.stopped) {
        stack.length = 0;
        return;
      }
      const frame = stack.pop() as Frame;
      const node = nodes[frame.node];
      const call = calls[frame.node];
      if (frame.entry === LoopEntry) {
        this.nextTurn(instance, node);
        continue;
      }
      const hooks = this.hooks;
      if (hooks) {
        if (!instance.resumed && hooks.shouldBreak(instance, node)) {
          stack.push(frame);
          hooks.pause(instance, node);
          return;
        }
        instance.resumed = false;
        instance.trace?.push(node.id);
      }
      if (++instance.steps > instance.maxSteps) {
        throw new BehaviorError(
          `Behavior graph "${this.program.graph.name}": more than ${instance.maxSteps} nodes in a chain (a loop of the flow?)`,
          node.id,
          instance.entity,
        );
      }
      instance.epoch++;
      call.runs++;
      call.time = instance.time;

      if (frame.entry === EventEntry) {
        const payload = frame.payload ?? {};
        for (const name of node.outputs) {
          call.outputs[name] = payload[name];
        }
        this.push(instance, node.exits[0]);
        continue;
      }
      if (node.kind === 'action') {
        const exit = node.type.run?.apply(
          undefined,
          this.args(instance, node) as Parameters<
            NonNullable<typeof node.type.run>
          >,
        );
        this.push(instance, node.exits[this.exitIndex(instance, node, exit)]);
        continue;
      }
      this.flow(instance, node, frame.entry);
    }
  }

  // The nodes of the flow, by type.
  private flow(
    instance: BehaviorInstance<H>,
    node: ProgramNode,
    entry: number,
  ): void {
    const call = instance.calls[node.index];
    const state = call.state;
    switch (node.node.type) {
      case 'flow.branch':
        this.push(
          instance,
          node.exits[this.value(instance, node.inputs[0]) ? 0 : 1],
        );
        return;
      case 'flow.sequence':
        for (let i = node.exits.length - 1; i >= 0; i--) {
          this.push(instance, node.exits[i]);
        }
        return;
      case 'flow.switch': {
        const value = this.value(instance, node.inputs[0]) as string;
        this.push(
          instance,
          node.exits[node.cases?.get(value) ?? node.exits.length - 1],
        );
        return;
      }
      case 'flow.doOnce':
        if (entry === 1) {
          state['done'] = false;
        } else if (!state['done']) {
          state['done'] = true;
          this.push(instance, node.exits[0]);
        }
        return;
      case 'flow.forLoop': {
        const first = this.value(instance, node.inputs[0]) as number;
        const last = this.value(instance, node.inputs[1]) as number;
        state['index'] = first;
        state['last'] = last;
        if (first <= last) {
          call.outputs['index'] = first;
          instance.stack.push({ node: node.index, entry: LoopEntry });
          this.push(instance, node.exits[0]);
        } else {
          this.push(instance, node.exits[1]);
        }
        return;
      }
      case 'flow.delay':
        if (!state['pending']) {
          state['pending'] = true;
          instance.wait(
            this.value(instance, node.inputs[0]) as number,
            node.index,
          );
        }
        return;
      default:
        throw new BehaviorError(
          `Node type "${node.node.type}" is a flow node the executors do not know`,
          node.id,
          instance.entity,
        );
    }
  }

  // The next turn of a loop, once its body ran.
  private nextTurn(instance: BehaviorInstance<H>, node: ProgramNode): void {
    const call = instance.calls[node.index];
    const index = (call.state['index'] as number) + 1;
    if (index <= (call.state['last'] as number)) {
      call.state['index'] = index;
      call.outputs['index'] = index;
      instance.stack.push({ node: node.index, entry: LoopEntry });
      this.push(instance, node.exits[0]);
    } else {
      this.push(instance, node.exits[1]);
    }
  }

  private push(
    instance: BehaviorInstance<H>,
    target: ExecTarget | undefined,
  ): void {
    if (target) {
      instance.stack.push({ node: target.node, entry: target.entry });
    }
  }

  private exitIndex(
    instance: BehaviorInstance<H>,
    node: ProgramNode,
    exit: unknown,
  ): number {
    if (typeof exit !== 'string') {
      return 0;
    }
    const index = node.exitNames.indexOf(exit);
    if (index < 0) {
      throw new BehaviorError(
        `Node type "${node.node.type}" returned the exit "${exit}", which it does not have`,
        node.id,
        instance.entity,
      );
    }
    return index;
  }

  // The call and the values of the data inputs of a node.
  private args(instance: BehaviorInstance<H>, node: ProgramNode): unknown[] {
    const args = this._args[node.index];
    args[0] = instance.calls[node.index];
    for (let i = 0; i < node.inputs.length; i++) {
      args[i + 1] = this.value(instance, node.inputs[i]);
    }
    return args;
  }

  private value(instance: BehaviorInstance<H>, source: DataSource): unknown {
    if (source.node < 0) {
      return source.value;
    }
    const node = this.program.nodes[source.node];
    if (node.kind === 'pure') {
      this.evaluate(instance, node);
    }
    return instance.calls[source.node].outputs[source.port];
  }

  // A pure node, once per node run: the values it gives stay those of the
  // node that reads them, however many of its inputs read them.
  private evaluate(instance: BehaviorInstance<H>, node: ProgramNode): void {
    if (instance.epochs[node.index] === instance.epoch) {
      return;
    }
    instance.epochs[node.index] = instance.epoch;
    const call = instance.calls[node.index];
    const result = node.type.evaluate?.apply(
      undefined,
      this.args(instance, node) as Parameters<
        NonNullable<typeof node.type.evaluate>
      >,
    );
    call.runs++;
    call.time = instance.time;
    if (node.outputs.length === 1) {
      call.outputs[node.outputs[0]] = result;
    } else {
      for (const name of node.outputs) {
        call.outputs[name] = (result as Record<string, unknown>)[name];
      }
    }
  }
}
