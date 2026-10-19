import type { BehaviorInstance } from './BehaviorInstance';
import type { BehaviorExecutor } from './Interpreter';
import type { BehaviorNodeType } from './nodes';
import {
  BehaviorError,
  type BehaviorProgram,
  type DataSource,
  type ExecTarget,
  type ProgramNode,
} from './program';

type Chain = (self: BehaviorInstance) => void;
type Handler = (
  self: BehaviorInstance,
  payload: Readonly<Record<string, unknown>>,
) => void;

// What the generated code receives: the node types, the constants, and
// the functions reporting errors.
interface Linked {
  readonly handlers: Readonly<Record<string, readonly Handler[]>>;
  readonly wake: readonly (Chain | undefined)[];
}

/**
 * A behavior graph compiled to JavaScript: a function per exec input of
 * each node, which computes the values the node reads (the pure nodes
 * inlined as expressions) and calls the function of the next node. Its
 * `source` can be read; it runs the same instances as the interpreter.
 *
 * Compiled by `new Function`: a page whose Content Security Policy forbids
 * `unsafe-eval` cannot use it (the {@link BehaviorSystem} then interprets).
 * The graph cannot inject code: its names and constants enter the source
 * as JSON strings, the code of the nodes comes from their types.
 *
 * @group Execution
 */
export class CompiledBehavior<H = unknown> implements BehaviorExecutor<H> {
  /** The generated JavaScript. */
  readonly source: string;
  private readonly _linked: Linked;

  constructor(readonly program: BehaviorProgram) {
    const { source, constants } = generate(program);
    this.source = source;
    const types: BehaviorNodeType[] = program.nodes.map((node) => node.type);
    const errors = {
      overflow: (self: BehaviorInstance, id: string) => {
        throw new BehaviorError(
          `Behavior graph "${program.graph.name}": more than ${self.maxSteps} nodes in a chain (a loop of the flow?)`,
          id,
          self.entity,
        );
      },
      exit: (
        self: BehaviorInstance,
        id: string,
        type: string,
        exit: string,
      ) => {
        throw new BehaviorError(
          `Node type "${type}" returned the exit "${exit}", which it does not have`,
          id,
          self.entity,
        );
      },
    };
    this._linked = new Function('T', 'K', 'X', source)(
      types,
      constants,
      errors,
    ) as Linked;
  }

  dispatch(
    instance: BehaviorInstance<H>,
    event: string,
    payload: Readonly<Record<string, unknown>>,
  ): void {
    const handlers = this._linked.handlers[event];
    if (!handlers) {
      return;
    }
    for (const handler of handlers) {
      instance.steps = 0;
      handler(instance as BehaviorInstance, payload);
    }
  }

  wake(instance: BehaviorInstance<H>, node: number): void {
    instance.steps = 0;
    this._linked.wake[node]?.(instance as BehaviorInstance);
  }
}

/**
 * Generates the JavaScript of a program: the body of a function of `T`
 * (the node types), `K` (the constants that are objects) and `X` (the
 * error reports), returning `{ handlers, wake }`.
 *
 * @group Execution
 */
export function generate(program: BehaviorProgram): {
  source: string;
  constants: unknown[];
} {
  const constants: unknown[] = [];
  const nodes = program.nodes;
  const lines: string[] = ['"use strict";'];
  const name = (target: ExecTarget) => `f${target.node}_${target.entry}`;
  const go = (target: ExecTarget | undefined) =>
    target ? `${name(target)}(self);` : '';

  // A function body: the pure values its node reads, declared once.
  class Body {
    readonly lines: string[] = [];
    private readonly _declared = new Set<number>();

    // The expression of a data input.
    value(source: DataSource): string {
      if (source.node < 0) {
        const value = source.value;
        if (typeof value === 'object' && value !== null) {
          constants.push(value);
          return `K[${constants.length - 1}]`;
        }
        return value === undefined ? 'undefined' : JSON.stringify(value);
      }
      const node = nodes[source.node];
      if (node.kind !== 'pure') {
        return `C[${node.index}].outputs[${JSON.stringify(source.port)}]`;
      }
      this.declare(node);
      return node.outputs.length === 1
        ? `v${node.index}`
        : `v${node.index}[${JSON.stringify(source.port)}]`;
    }

    private declare(node: ProgramNode): void {
      if (this._declared.has(node.index)) {
        return;
      }
      const inputs = node.inputs.map((input) => this.value(input));
      this._declared.add(node.index);
      const expression = node.type.inline
        ? node.type.inline(inputs, node.params)
        : `T[${node.index}].evaluate(${[`C[${node.index}]`, ...inputs].join(', ')})`;
      this.lines.push(`const v${node.index} = ${expression};`);
    }
  }

  const handlers = new Map<string, string[]>();
  const wakes: string[] = [];
  for (const node of nodes) {
    const id = JSON.stringify(node.id);
    if (node.kind === 'event') {
      const body = node.outputs
        .map((output) => {
          const key = JSON.stringify(output);
          return `o[${key}] = payload[${key}];`;
        })
        .join(' ');
      lines.push(
        `function h${node.index}(self, payload) {`,
        `  const o = self.calls[${node.index}].outputs; ${body}`,
        `  ${go(node.exits[0])}`,
        '}',
      );
      const event = node.type.event?.(node.params) as string;
      let list = handlers.get(event);
      if (!list) {
        handlers.set(event, (list = []));
      }
      list.push(`h${node.index}`);
      continue;
    }
    if (node.kind === 'pure') {
      continue;
    }
    node.entries.forEach((_, entry) => {
      const body = new Body();
      const code = statements(node, entry, body, go);
      lines.push(
        `function f${node.index}_${entry}(self) {`,
        '  if (self.stopped) return;',
        `  if (++self.steps > self.maxSteps) X.overflow(self, ${id});`,
        '  const C = self.calls;',
        ...body.lines.map((line) => `  ${line}`),
        ...code.map((line) => `  ${line}`),
        '}',
      );
    });
    if (node.node.type === 'flow.delay') {
      lines.push(
        `function w${node.index}(self) {`,
        `  self.calls[${node.index}].state.pending = false;`,
        `  ${go(node.exits[0])}`,
        '}',
      );
      wakes[node.index] = `w${node.index}`;
    }
  }
  const handlerTable = [...handlers]
    .map(([event, list]) => `${JSON.stringify(event)}: [${list.join(', ')}]`)
    .join(', ');
  const wakeTable = Array.from(
    { length: nodes.length },
    (_, i) => wakes[i] ?? 'undefined',
  ).join(', ');
  lines.push(`return { handlers: { ${handlerTable} }, wake: [${wakeTable}] };`);
  return { source: lines.join('\n'), constants };
}

// The statements of a node entered by an exec input.
function statements(
  node: ProgramNode,
  entry: number,
  body: { value(source: DataSource): string },
  go: (target: ExecTarget | undefined) => string,
): string[] {
  const i = node.index;
  const exits = node.exits;
  const input = (k: number) => body.value(node.inputs[k]);
  switch (node.node.type) {
    case 'var.set': {
      const key = JSON.stringify(node.params['name'] as string);
      return [
        `const value = ${input(0)};`,
        `self.variables[${key}] = value;`,
        'C[' + i + '].outputs.value = value;',
        go(exits[0]),
      ];
    }
    case 'flow.branch':
      return [`if (${input(0)}) { ${go(exits[0])} } else { ${go(exits[1])} }`];
    case 'flow.sequence':
      return exits.map(go);
    case 'flow.switch': {
      const cases = [...(node.cases ?? new Map<string, number>())].map(
        ([name, exit]) =>
          `case ${JSON.stringify(name)}: ${go(exits[exit])} break;`,
      );
      return [
        `switch (${input(0)}) {`,
        ...cases.map((line) => `  ${line}`),
        `  default: ${go(exits[exits.length - 1])}`,
        '}',
      ];
    }
    case 'flow.doOnce':
      return entry === 1
        ? [`C[${i}].state.done = false;`]
        : [
            `const s = C[${i}].state;`,
            `if (!s.done) { s.done = true; ${go(exits[0])} }`,
          ];
    case 'flow.forLoop':
      return [
        `const first = ${input(0)}, last = ${input(1)};`,
        `const o = C[${i}].outputs;`,
        'for (let k = first; k <= last; k++) {',
        `  o.index = k; ${go(exits[0])}`,
        '  if (self.stopped) return;',
        '}',
        go(exits[1]),
      ];
    case 'flow.delay':
      return [
        `const s = C[${i}].state;`,
        `if (!s.pending) { s.pending = true; self.wait(${input(0)}, ${i}); }`,
      ];
  }
  if (node.kind === 'flow') {
    throw new Error(
      `Node type "${node.node.type}" is a flow node the compiler does not know`,
    );
  }
  // An action: its run, then the exit it returns.
  const args = [`C[${i}]`, ...node.inputs.map((_, k) => input(k))].join(', ');
  const id = JSON.stringify(node.id);
  const type = JSON.stringify(node.node.type);
  const wrong = `X.exit(self, ${id}, ${type}, exit);`;
  if (exits.length === 1) {
    return [
      `const exit = T[${i}].run(${args});`,
      `if (typeof exit === "string" && exit !== ${JSON.stringify(node.exitNames[0])}) ${wrong}`,
      go(exits[0]),
    ];
  }
  return [
    `const exit = T[${i}].run(${args});`,
    'switch (exit) {',
    ...node.exitNames.map(
      (exit, k) => `  case ${JSON.stringify(exit)}: ${go(exits[k])} break;`,
    ),
    `  default: if (typeof exit === "string") ${wrong} ${go(exits[0])}`,
    '}',
  ];
}
