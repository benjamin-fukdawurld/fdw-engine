import {
  type NodeId,
  type NodeType,
  type ParamSchema,
  type PortSpec,
  Registry,
} from '@fdw/engine-graph';
import {
  type BehaviorPortType,
  type BehaviorValue,
  type BehaviorValueType,
  type EventField,
  type Vec3,
  zeroOf,
} from './data';

/**
 * What a node can reach of the instance running it: its entity, the host
 * (the game), its variables, its clock.
 *
 * @typeParam H - The host given to the {@link BehaviorSystem}.
 *
 * @group Nodes
 */
export interface BehaviorContext<H = unknown> {
  /** The entity the graph runs for. */
  readonly entity: number;
  /** What the application gives the nodes: the game, its world. */
  readonly host: H;
  /** The variables of the instance, by name. */
  readonly variables: Record<string, BehaviorValue>;
  /** Seconds since the instance started, advanced by each run. */
  readonly time: number;
  /** A number in [0, 1), from the random source of the system. */
  random(): number;
  /**
   * Sends an event to this instance, or to the instance of another entity
   * of the system: handled once the current chain is over.
   */
  emit(
    event: string,
    payload?: Readonly<Record<string, unknown>>,
    target?: number,
  ): void;
  /** Writes a line to the log of the system. */
  log(text: string): void;
}

/**
 * A node of a graph, for an instance: what its implementation receives.
 * Kept from one run to the next.
 *
 * @group Nodes
 */
export interface NodeCall<H = unknown> {
  readonly self: BehaviorContext<H>;
  readonly id: NodeId;
  /** The parameters of the node, defaults applied. */
  readonly params: Readonly<Record<string, unknown>>;
  /**
   * The values of the data outputs, by port: written by the events and the
   * actions when they run, read by the nodes after them (and by the
   * debugger).
   */
  readonly outputs: Record<string, unknown>;
  /** What the node keeps between two runs (a cooldown, a counter). */
  readonly state: Record<string, unknown>;
  /** How many times the node ran (or was evaluated, for a pure node). */
  runs: number;
  /** The time of the instance at its last run; -1 before. */
  time: number;
}

/**
 * What a node does:
 * - `event`: starts a chain when its event comes (`event.update`);
 * - `flow`: chooses where the chain goes (`flow.branch`, `flow.delay`):
 *   the executors implement them;
 * - `action`: does something, then goes on (`var.set`, the actions of the
 *   game);
 * - `pure`: computes values from its inputs, on demand, without exec
 *   ports (`math.add`, `var.get`).
 *
 * @group Nodes
 */
export type BehaviorNodeKind = 'event' | 'flow' | 'action' | 'pure';

/**
 * A node type of the behavior graphs: its ports, and what it does.
 *
 * @typeParam H - The host its implementation expects.
 *
 * @group Nodes
 */
export interface BehaviorNodeType<
  H = any, // eslint-disable-line @typescript-eslint/no-explicit-any
> extends NodeType<BehaviorPortType> {
  readonly kind: BehaviorNodeKind;
  /**
   * The function or the macro a `call.<name>` node calls, or the one whose
   * ports `fn.inputs` and `fn.outputs` are: laid in the graph before it
   * runs, without implementation of their own.
   */
  readonly function?: string;
  /** `event` nodes: the name of the event they handle. */
  readonly event?: (params: Readonly<Record<string, unknown>>) => string;
  /**
   * `pure` nodes: the value of the output from the values of the data
   * inputs, in the order of the ports; an object by port name when the node
   * has several outputs.
   */
  readonly evaluate?: (
    call: NodeCall<H>,
    ...inputs: any[] // eslint-disable-line @typescript-eslint/no-explicit-any
  ) => unknown;
  /**
   * `action` nodes: does the work from the values of the data inputs,
   * writes the data outputs in `call.outputs`, returns the exec output to
   * go on with (the first one when it returns anything but a string).
   */
  readonly run?: (
    call: NodeCall<H>,
    ...inputs: any[] // eslint-disable-line @typescript-eslint/no-explicit-any
  ) => string | void;
  /**
   * `pure` nodes, for the compiler: a JavaScript expression of the
   * expressions of the inputs (`self` is the instance). Without it, the
   * compiled code calls `evaluate`.
   */
  readonly inline?: (
    inputs: readonly string[],
    params: Readonly<Record<string, unknown>>,
  ) => string;
}

/** The exec input of the actions and the flow nodes. @group Nodes */
export const ExecInput = 'exec';
/** The exec output of the actions and the events that have one. @group Nodes */
export const ThenOutput = 'then';

/**
 * An exec input: reached from as many nodes as wanted.
 *
 * @group Nodes
 */
export const execIn = (name = ExecInput): PortSpec<BehaviorPortType> => ({
  name,
  type: 'exec',
  connections: 'many',
  optional: true,
});

/**
 * An exec output: goes on to one node.
 *
 * @group Nodes
 */
export const execOut = (name = ThenOutput): PortSpec<BehaviorPortType> => ({
  name,
  type: 'exec',
  connections: 'one',
});

/**
 * A data input: its type, or its type and its default value.
 *
 * @group Nodes
 */
export type InputDeclaration =
  | BehaviorValueType
  | {
      readonly type: BehaviorValueType;
      readonly default?: BehaviorValue;
      readonly optional?: boolean;
      readonly description?: string;
    };

const dataInputs = (
  inputs: Readonly<Record<string, InputDeclaration>>,
): PortSpec<BehaviorPortType>[] =>
  Object.entries(inputs).map(([name, input]) =>
    typeof input === 'string' ? { name, type: input } : { name, ...input },
  );

const dataOutputs = (
  outputs: Readonly<Record<string, BehaviorValueType>>,
): PortSpec<BehaviorPortType>[] =>
  Object.entries(outputs).map(([name, type]) => ({ name, type }));

/**
 * Declares an action: a node of the flow of execution that does something
 * (moves a character, plays a sound), then goes on by one of its `exits`
 * (`then` by default), the one `run` returns.
 *
 * @example
 * ```ts
 * const strike = actionNode<Game>({
 *   id: 'game.strike',
 *   inputs: { damage: { type: 'number', default: 10 } },
 *   outputs: { hit: 'boolean' },
 *   run: (call, damage: number) => {
 *     call.outputs['hit'] = call.self.host.strike(call.self.entity, damage);
 *   },
 * });
 * ```
 *
 * @group Nodes
 */
export function actionNode<H = unknown>(spec: {
  readonly id: string;
  readonly description?: string;
  readonly category?: string;
  readonly params?: Readonly<Record<string, ParamSchema>>;
  readonly inputs?: Readonly<Record<string, InputDeclaration>>;
  readonly outputs?: Readonly<Record<string, BehaviorValueType>>;
  /** The exec outputs: `['then']` by default. */
  readonly exits?: readonly string[];
  readonly run: (
    call: NodeCall<H>,
    ...inputs: any[] // eslint-disable-line @typescript-eslint/no-explicit-any
  ) => string | void;
}): BehaviorNodeType<H> {
  const inputs = [execIn(), ...dataInputs(spec.inputs ?? {})];
  const outputs = [
    ...(spec.exits ?? [ThenOutput]).map((name) => execOut(name)),
    ...dataOutputs(spec.outputs ?? {}),
  ];
  return {
    id: spec.id,
    kind: 'action',
    category: spec.category ?? 'action',
    ...(spec.description !== undefined
      ? { description: spec.description }
      : {}),
    ...(spec.params !== undefined ? { params: spec.params } : {}),
    inputs: () => inputs,
    outputs: () => outputs,
    run: spec.run,
  };
}

/**
 * Declares a pure node: values computed from its inputs, on demand, by the
 * nodes that read them. Its outputs are `{ value: type }` when `output`
 * gives a single type; `evaluate` then returns the value, else an object by
 * output name.
 *
 * @example
 * ```ts
 * const distance = pureNode<Game>({
 *   id: 'game.distanceToHero',
 *   output: 'number',
 *   evaluate: (call) => call.self.host.distanceToHero(call.self.entity),
 * });
 * ```
 *
 * @group Nodes
 */
export function pureNode<H = unknown>(spec: {
  readonly id: string;
  readonly description?: string;
  readonly category?: string;
  readonly params?: Readonly<Record<string, ParamSchema>>;
  readonly inputs?: Readonly<Record<string, InputDeclaration>>;
  /** One output, `value`, of this type… */
  readonly output?: BehaviorValueType;
  /** …or several. */
  readonly outputs?: Readonly<Record<string, BehaviorValueType>>;
  readonly evaluate: (
    call: NodeCall<H>,
    ...inputs: any[] // eslint-disable-line @typescript-eslint/no-explicit-any
  ) => unknown;
  readonly inline?: BehaviorNodeType['inline'];
}): BehaviorNodeType<H> {
  const inputs = dataInputs(spec.inputs ?? {});
  const outputs = dataOutputs(
    spec.outputs ?? { value: spec.output ?? 'number' },
  );
  return {
    id: spec.id,
    kind: 'pure',
    category: spec.category ?? 'value',
    ...(spec.description !== undefined
      ? { description: spec.description }
      : {}),
    ...(spec.params !== undefined ? { params: spec.params } : {}),
    inputs: () => inputs,
    outputs: () => outputs,
    evaluate: spec.evaluate,
    ...(spec.inline !== undefined ? { inline: spec.inline } : {}),
  };
}

/**
 * The fields of an event, from the parameters of a node (`fields`).
 *
 * @group Nodes
 */
export function fieldsOf(
  params: Readonly<Record<string, unknown>>,
): readonly EventField[] {
  const fields = params['fields'] ?? [];
  if (
    !Array.isArray(fields) ||
    !fields.every(
      (field) =>
        typeof field === 'object' &&
        field !== null &&
        typeof (field as EventField).name === 'string' &&
        typeof (field as EventField).type === 'string',
    )
  ) {
    throw new Error('"fields" must be an array of { name, type }');
  }
  return fields as EventField[];
}

/**
 * The cases of a `flow.switch`, from its parameters.
 *
 * @group Nodes
 */
export function casesOf(
  params: Readonly<Record<string, unknown>>,
): readonly string[] {
  const cases = params['cases'];
  if (
    !Array.isArray(cases) ||
    !cases.every((name) => typeof name === 'string')
  ) {
    throw new Error('"cases" must be an array of strings');
  }
  return cases as string[];
}

const valueType = (
  params: Readonly<Record<string, unknown>>,
): BehaviorValueType => params['type'] as BehaviorValueType;

const typeParam = (
  fallback?: BehaviorValueType,
): ParamSchema<'string', string> => ({
  kind: 'string',
  values: ['number', 'boolean', 'string', 'vec3', 'entity'],
  ...(fallback ? { default: fallback } : { required: true }),
});

// --- Events --------------------------------------------------------------

/**
 * Runs its chain once, when the instance starts (its first run).
 *
 * @group Nodes
 */
export const startEvent: BehaviorNodeType = {
  id: 'event.start',
  kind: 'event',
  category: 'event',
  description: 'Runs once, when the instance starts.',
  event: () => 'start',
  inputs: () => [],
  outputs: () => [execOut()],
};

/**
 * Runs its chain at each run of the system (each fixed step when it is
 * installed in the `fixed` phase), with the time of the step.
 *
 * @group Nodes
 */
export const updateEvent: BehaviorNodeType = {
  id: 'event.update',
  kind: 'event',
  category: 'event',
  description: 'Runs at each run of the system, with its time step.',
  event: () => 'update',
  inputs: () => [],
  outputs: () => [execOut(), { name: 'dt', type: 'number' }],
};

/**
 * Runs its chain when its event comes: sent by the application
 * (`system.emit`) or by a graph (`event.emit`), with the fields declared.
 *
 * @group Nodes
 */
export const onEvent: BehaviorNodeType = {
  id: 'event.on',
  kind: 'event',
  category: 'event',
  description: 'Runs when an event is sent to the instance.',
  params: {
    event: { kind: 'string', required: true },
    fields: { kind: 'json', default: [] },
  },
  event: (params) => params['event'] as string,
  inputs: () => [],
  outputs: (params) => [
    execOut(),
    ...fieldsOf(params).map(({ name, type }) => ({ name, type })),
  ],
};

/**
 * Sends an event, with its fields, to this instance or to the instance of
 * another entity of the system (`target`).
 *
 * @group Nodes
 */
export const emitNode: BehaviorNodeType = {
  id: 'event.emit',
  kind: 'action',
  category: 'event',
  description:
    'Sends an event to this instance or another: handled once the current chain is over.',
  params: {
    event: { kind: 'string', required: true },
    fields: { kind: 'json', default: [] },
  },
  inputs: (params) => [
    execIn(),
    {
      name: 'target',
      type: 'entity',
      optional: true,
      description:
        'The entity whose instance receives it: this one by default.',
    },
    ...fieldsOf(params).map(({ name, type }) => ({
      name,
      type,
      default: zeroOf(type),
    })),
  ],
  outputs: () => [execOut()],
  run: (call, target: number | undefined, ...values: unknown[]) => {
    const payload: Record<string, unknown> = {};
    fieldsOf(call.params).forEach(
      (field, i) => (payload[field.name] = values[i]),
    );
    call.self.emit(call.params['event'] as string, payload, target);
  },
};

// --- Flow ----------------------------------------------------------------

/**
 * Goes on by `true` or `false`.
 *
 * @group Nodes
 */
export const branchNode: BehaviorNodeType = {
  id: 'flow.branch',
  kind: 'flow',
  category: 'flow',
  description: 'Goes on by "true" or "false", after the condition.',
  inputs: () => [execIn(), { name: 'condition', type: 'boolean' }],
  outputs: () => [execOut('true'), execOut('false')],
};

/**
 * Runs the chains of its outputs one after the other.
 *
 * @group Nodes
 */
export const sequenceNode: BehaviorNodeType = {
  id: 'flow.sequence',
  kind: 'flow',
  category: 'flow',
  description: 'Runs the chains of its outputs one after the other.',
  params: { count: { kind: 'number', default: 2 } },
  inputs: () => [execIn()],
  outputs: (params) =>
    Array.from({ length: params['count'] as number }, (_, i) =>
      execOut(`then${i}`),
    ),
};

/**
 * Goes on by the output named after a string (a state), or `default`.
 *
 * @group Nodes
 */
export const switchNode: BehaviorNodeType = {
  id: 'flow.switch',
  kind: 'flow',
  category: 'flow',
  description:
    'Goes on by the output named after the value (a state), else by "default".',
  params: { cases: { kind: 'json', required: true } },
  inputs: () => [execIn(), { name: 'value', type: 'string' }],
  outputs: (params) => [
    ...casesOf(params).map((name) => execOut(name)),
    execOut('default'),
  ],
};

/**
 * Goes on the first time only, until `reset`.
 *
 * @group Nodes
 */
export const doOnceNode: BehaviorNodeType = {
  id: 'flow.doOnce',
  kind: 'flow',
  category: 'flow',
  description: 'Goes on the first time only, until "reset" is reached.',
  inputs: () => [execIn(), execIn('reset')],
  outputs: () => [execOut()],
};

/**
 * Runs `body` for each index from `first` to `last`, then `completed`.
 *
 * @group Nodes
 */
export const forLoopNode: BehaviorNodeType = {
  id: 'flow.forLoop',
  kind: 'flow',
  category: 'flow',
  description:
    'Runs "body" for each index from "first" to "last" (included), then "completed".',
  inputs: () => [
    execIn(),
    { name: 'first', type: 'number', default: 0 },
    { name: 'last', type: 'number', default: 0 },
  ],
  outputs: () => [
    execOut('body'),
    { name: 'index', type: 'number' },
    execOut('completed'),
  ],
};

/**
 * Goes on after some seconds of the instance; reached again while waiting,
 * it does nothing.
 *
 * @group Nodes
 */
export const delayNode: BehaviorNodeType = {
  id: 'flow.delay',
  kind: 'flow',
  category: 'flow',
  description:
    'Goes on after some seconds; reached again while it waits, does nothing.',
  inputs: () => [execIn(), { name: 'seconds', type: 'number', default: 1 }],
  outputs: () => [execOut()],
};

// --- Variables -----------------------------------------------------------

/**
 * The value of a variable of the instance.
 *
 * @group Nodes
 */
export const getNode: BehaviorNodeType = {
  id: 'var.get',
  kind: 'pure',
  category: 'variable',
  description: 'The value of a variable.',
  params: { name: { kind: 'string', required: true }, type: typeParam() },
  inputs: () => [],
  outputs: (params) => [{ name: 'value', type: valueType(params) }],
  evaluate: (call) => call.self.variables[call.params['name'] as string],
  inline: (_, params) =>
    `self.variables[${JSON.stringify(params['name'] as string)}]`,
};

/**
 * Sets a variable of the instance, and gives its new value.
 *
 * @group Nodes
 */
export const setNode: BehaviorNodeType = {
  id: 'var.set',
  kind: 'action',
  category: 'variable',
  description: 'Sets a variable, and gives its new value.',
  params: { name: { kind: 'string', required: true }, type: typeParam() },
  inputs: (params) => [execIn(), { name: 'value', type: valueType(params) }],
  outputs: (params) => [execOut(), { name: 'value', type: valueType(params) }],
  run: (call, value: BehaviorValue) => {
    call.self.variables[call.params['name'] as string] = value;
    call.outputs['value'] = value;
  },
};

// --- Values --------------------------------------------------------------

const number = (fallback: number): InputDeclaration => ({
  type: 'number',
  default: fallback,
});

/**
 * A constant: given once, read by many.
 *
 * @group Nodes
 */
export const constantNode: BehaviorNodeType = {
  id: 'value.constant',
  kind: 'pure',
  category: 'value',
  description: 'A constant value.',
  params: { type: typeParam('number'), value: { kind: 'json', default: 0 } },
  inputs: () => [],
  outputs: (params) => [{ name: 'value', type: valueType(params) }],
  evaluate: (call) => call.params['value'],
  inline: (_, params) => `(${JSON.stringify(params['value'])})`,
};

/**
 * `ifTrue` or `ifFalse`, after a condition.
 *
 * @group Nodes
 */
export const selectNode: BehaviorNodeType = {
  id: 'value.select',
  kind: 'pure',
  category: 'value',
  description: '"ifTrue" or "ifFalse", after the condition.',
  params: { type: typeParam('number') },
  inputs: (params) => [
    { name: 'condition', type: 'boolean' },
    { name: 'ifTrue', type: valueType(params) },
    { name: 'ifFalse', type: valueType(params) },
  ],
  outputs: (params) => [{ name: 'value', type: valueType(params) }],
  evaluate: (_, condition: boolean, a: unknown, b: unknown) =>
    condition ? a : b,
  inline: ([condition, a, b]) => `(${condition} ? ${a} : ${b})`,
};

/**
 * Whether two values are equal (vectors by their components).
 *
 * @group Nodes
 */
export const equalsNode = pureNode({
  id: 'value.equals',
  description: 'Whether two values are equal; vectors by their components.',
  inputs: { a: 'any', b: 'any' },
  output: 'boolean',
  evaluate: (_, a: unknown, b: unknown) => valuesEqual(a, b),
});

/**
 * Whether two values are equal: vectors by their components.
 *
 * @group Nodes
 */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a === 'object' && typeof b === 'object' && a && b) {
    const u = a as Vec3;
    const v = b as Vec3;
    return u.x === v.x && u.y === v.y && u.z === v.z;
  }
  return false;
}

/**
 * The entity of the instance.
 *
 * @group Nodes
 */
export const selfNode = pureNode({
  id: 'entity.self',
  description: 'The entity the graph runs for.',
  output: 'entity',
  evaluate: (call) => call.self.entity,
  inline: () => 'self.entity',
});

/**
 * Seconds since the instance started.
 *
 * @group Nodes
 */
export const timeNode = pureNode({
  id: 'time.now',
  description: 'Seconds since the instance started.',
  output: 'number',
  evaluate: (call) => call.self.time,
  inline: () => 'self.time',
});

// The arithmetic: [id, description, evaluate, inline operator or function].
const binary = (
  id: string,
  description: string,
  evaluate: (a: number, b: number) => number,
  inline: (a: string, b: string) => string,
  defaults: [number, number] = [0, 0],
): BehaviorNodeType =>
  pureNode({
    id,
    description,
    inputs: { a: number(defaults[0]), b: number(defaults[1]) },
    output: 'number',
    evaluate: (_, a: number, b: number) => evaluate(a, b),
    inline: ([a, b]) => inline(a, b),
  });

/** a + b. @group Nodes */
export const addNode = binary(
  'math.add',
  'a + b',
  (a, b) => a + b,
  (a, b) => `(${a} + ${b})`,
);
/** a − b. @group Nodes */
export const subNode = binary(
  'math.sub',
  'a − b',
  (a, b) => a - b,
  (a, b) => `(${a} - ${b})`,
);
/** a × b. @group Nodes */
export const mulNode = binary(
  'math.mul',
  'a × b',
  (a, b) => a * b,
  (a, b) => `(${a} * ${b})`,
  [1, 1],
);
/** a / b. @group Nodes */
export const divNode = binary(
  'math.div',
  'a / b',
  (a, b) => a / b,
  (a, b) => `(${a} / ${b})`,
  [0, 1],
);
/** The smaller. @group Nodes */
export const minNode = binary(
  'math.min',
  'The smaller of a and b.',
  Math.min,
  (a, b) => `Math.min(${a}, ${b})`,
);
/** The larger. @group Nodes */
export const maxNode = binary(
  'math.max',
  'The larger of a and b.',
  Math.max,
  (a, b) => `Math.max(${a}, ${b})`,
);

/** |value|. @group Nodes */
export const absNode = pureNode({
  id: 'math.abs',
  description: '|value|',
  inputs: { value: number(0) },
  output: 'number',
  evaluate: (_, value: number) => Math.abs(value),
  inline: ([value]) => `Math.abs(${value})`,
});

/** The value within [min, max]. @group Nodes */
export const clampNode = pureNode({
  id: 'math.clamp',
  description: 'The value within [min, max].',
  inputs: { value: number(0), min: number(0), max: number(1) },
  output: 'number',
  evaluate: (_, value: number, min: number, max: number) =>
    Math.min(Math.max(value, min), max),
  inline: ([value, min, max]) => `Math.min(Math.max(${value}, ${min}), ${max})`,
});

/** a + (b − a) t. @group Nodes */
export const lerpNode = pureNode({
  id: 'math.lerp',
  description: 'a + (b − a) t',
  inputs: { a: number(0), b: number(1), t: number(0.5) },
  output: 'number',
  evaluate: (_, a: number, b: number, t: number) => a + (b - a) * t,
  inline: ([a, b, t]) => `(${a} + (${b} - ${a}) * ${t})`,
});

/**
 * A number in [min, max), drawn each time it is read.
 *
 * @group Nodes
 */
export const randomNode = pureNode({
  id: 'math.random',
  description: 'A number in [min, max), drawn each time it is read.',
  inputs: { min: number(0), max: number(1) },
  output: 'number',
  evaluate: (call, min: number, max: number) =>
    min + call.self.random() * (max - min),
  inline: ([min, max]) => `(${min} + self.random() * (${max} - ${min}))`,
});

/**
 * The comparisons of {@link compareNode}.
 *
 * @group Nodes
 */
export type CompareOperator = '<' | '<=' | '>' | '>=' | '==' | '!=';

const compare = (op: CompareOperator, a: number, b: number): boolean => {
  switch (op) {
    case '<':
      return a < b;
    case '<=':
      return a <= b;
    case '>':
      return a > b;
    case '>=':
      return a >= b;
    case '==':
      return a === b;
    case '!=':
      return a !== b;
  }
};

/**
 * Compares two numbers.
 *
 * @group Nodes
 */
export const compareNode = pureNode({
  id: 'math.compare',
  description: 'Compares two numbers: a < b, a >= b…',
  params: {
    op: {
      kind: 'string',
      values: ['<', '<=', '>', '>=', '==', '!='],
      default: '<',
    },
  },
  inputs: { a: number(0), b: number(0) },
  output: 'boolean',
  evaluate: (call, a: number, b: number) =>
    compare(call.params['op'] as CompareOperator, a, b),
  inline: ([a, b], params) => {
    const op = params['op'] as CompareOperator;
    const js = op === '==' ? '===' : op === '!=' ? '!==' : op;
    return `(${a} ${js} ${b})`;
  },
});

/** a and b. @group Nodes */
export const andNode = pureNode({
  id: 'logic.and',
  description: 'a and b',
  inputs: { a: 'boolean', b: 'boolean' },
  output: 'boolean',
  evaluate: (_, a: boolean, b: boolean) => a && b,
  inline: ([a, b]) => `(${a} && ${b})`,
});

/** a or b. @group Nodes */
export const orNode = pureNode({
  id: 'logic.or',
  description: 'a or b',
  inputs: { a: 'boolean', b: 'boolean' },
  output: 'boolean',
  evaluate: (_, a: boolean, b: boolean) => a || b,
  inline: ([a, b]) => `(${a} || ${b})`,
});

/** Not the value. @group Nodes */
export const notNode = pureNode({
  id: 'logic.not',
  description: 'not value',
  inputs: { value: 'boolean' },
  output: 'boolean',
  evaluate: (_, value: boolean) => !value,
  inline: ([value]) => `(!${value})`,
});

// --- Vectors -------------------------------------------------------------

/** A vector of its components. @group Nodes */
export const makeVec3Node = pureNode({
  id: 'vec3.make',
  category: 'vector',
  description: 'A vector of its components.',
  inputs: { x: number(0), y: number(0), z: number(0) },
  output: 'vec3',
  evaluate: (_, x: number, y: number, z: number): Vec3 => ({ x, y, z }),
  inline: ([x, y, z]) => `({ x: ${x}, y: ${y}, z: ${z} })`,
});

/** The components of a vector. @group Nodes */
export const breakVec3Node = pureNode({
  id: 'vec3.break',
  category: 'vector',
  description: 'The components of a vector.',
  inputs: { vector: 'vec3' },
  outputs: { x: 'number', y: 'number', z: 'number' },
  // A vector is already the object of its components.
  evaluate: (_, vector: Vec3) => vector,
  inline: ([vector]) => vector,
});

/** a + b. @group Nodes */
export const addVec3Node = pureNode({
  id: 'vec3.add',
  category: 'vector',
  description: 'a + b',
  inputs: { a: 'vec3', b: 'vec3' },
  output: 'vec3',
  evaluate: (_, a: Vec3, b: Vec3): Vec3 => ({
    x: a.x + b.x,
    y: a.y + b.y,
    z: a.z + b.z,
  }),
});

/** a − b. @group Nodes */
export const subVec3Node = pureNode({
  id: 'vec3.sub',
  category: 'vector',
  description: 'a − b',
  inputs: { a: 'vec3', b: 'vec3' },
  output: 'vec3',
  evaluate: (_, a: Vec3, b: Vec3): Vec3 => ({
    x: a.x - b.x,
    y: a.y - b.y,
    z: a.z - b.z,
  }),
});

/** vector × scale. @group Nodes */
export const scaleVec3Node = pureNode({
  id: 'vec3.scale',
  category: 'vector',
  description: 'vector × scale',
  inputs: { vector: 'vec3', scale: number(1) },
  output: 'vec3',
  evaluate: (_, v: Vec3, s: number): Vec3 => ({
    x: v.x * s,
    y: v.y * s,
    z: v.z * s,
  }),
});

/** |vector|. @group Nodes */
export const lengthVec3Node = pureNode({
  id: 'vec3.length',
  category: 'vector',
  description: 'The length of a vector.',
  inputs: { vector: 'vec3' },
  output: 'number',
  evaluate: (_, v: Vec3) => Math.hypot(v.x, v.y, v.z),
});

/** |a − b|. @group Nodes */
export const distanceVec3Node = pureNode({
  id: 'vec3.distance',
  category: 'vector',
  description: 'The distance between two points.',
  inputs: { a: 'vec3', b: 'vec3' },
  output: 'number',
  evaluate: (_, a: Vec3, b: Vec3) =>
    Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z),
});

/** The vector of length 1 along another (zero stays zero). @group Nodes */
export const normalizeVec3Node = pureNode({
  id: 'vec3.normalize',
  category: 'vector',
  description: 'The vector of length 1 along another; zero stays zero.',
  inputs: { vector: 'vec3' },
  output: 'vec3',
  evaluate: (_, v: Vec3): Vec3 => {
    const length = Math.hypot(v.x, v.y, v.z);
    return length > 0
      ? { x: v.x / length, y: v.y / length, z: v.z / length }
      : { x: 0, y: 0, z: 0 };
  },
});

// --- Debugging -----------------------------------------------------------

/**
 * Writes a line to the log of the system: its text, then its value.
 *
 * @group Nodes
 */
export const logNode = actionNode({
  id: 'debug.log',
  category: 'debug',
  description: 'Writes a line to the log of the system.',
  params: { text: { kind: 'string', default: '' } },
  inputs: { value: { type: 'any', optional: true } },
  run: (call, value: unknown) => {
    const text = call.params['text'] as string;
    call.self.log(
      value === undefined
        ? text
        : `${text}${text ? ' ' : ''}${typeof value === 'object' ? JSON.stringify(value) : String(value)}`,
    );
  },
});

/**
 * The standard node types of the behavior graphs.
 *
 * @group Nodes
 */
export const behaviorNodeTypes: readonly BehaviorNodeType[] = [
  startEvent,
  updateEvent,
  onEvent,
  emitNode,
  branchNode,
  sequenceNode,
  switchNode,
  doOnceNode,
  forLoopNode,
  delayNode,
  getNode,
  setNode,
  constantNode,
  selectNode,
  equalsNode,
  selfNode,
  timeNode,
  addNode,
  subNode,
  mulNode,
  divNode,
  minNode,
  maxNode,
  absNode,
  clampNode,
  lerpNode,
  randomNode,
  compareNode,
  andNode,
  orNode,
  notNode,
  makeVec3Node,
  breakVec3Node,
  addVec3Node,
  subVec3Node,
  scaleVec3Node,
  lengthVec3Node,
  distanceVec3Node,
  normalizeVec3Node,
  logNode,
];

/**
 * A registry of the standard node types, and of those of an application
 * (its actions, its queries).
 *
 * @example
 * ```ts
 * const registry = createBehaviorRegistry([strike, distanceToHero]);
 * ```
 *
 * @group Nodes
 */
export const createBehaviorRegistry = (
  extra: Iterable<BehaviorNodeType> = [],
): Registry<BehaviorNodeType> =>
  new Registry<BehaviorNodeType>([...behaviorNodeTypes, ...extra]);
