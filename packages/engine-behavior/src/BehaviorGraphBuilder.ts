import {
  type GraphEdge,
  GraphError,
  type NodeId,
  type Registry,
  resolveParams,
} from '@fdw/engine-graph';
import {
  type BehaviorFunctionData,
  type BehaviorGraphData,
  BehaviorGraphFormat,
  BehaviorGraphVersion,
  type BehaviorNode,
  type BehaviorPortType,
  type BehaviorSignaturePort,
  type BehaviorValue,
  type BehaviorVariable,
  type EventField,
} from './data';
import {
  type BehaviorNodeType,
  type CompareOperator,
  createBehaviorRegistry,
  ExecInput,
  ThenOutput,
} from './nodes';
import {
  bodyNodeTypes,
  callNodeType,
  callType,
  FunctionInputs,
  FunctionOutputs,
} from './functions';
import { validateBehaviorGraph } from './validate';

/**
 * An exec output of a node of a {@link BehaviorGraphBuilder}: where a chain
 * goes on.
 *
 * @group Behavior graph
 */
export class Exec {
  constructor(
    readonly node: NodeId,
    readonly port: string,
  ) {}
}

/**
 * A data output of a node of a {@link BehaviorGraphBuilder}: a value read
 * by other nodes.
 *
 * @group Behavior graph
 */
export class Value {
  constructor(
    readonly node: NodeId,
    readonly port: string,
    readonly type: BehaviorPortType,
  ) {}
}

/**
 * A data input: a value of the graph, or a constant.
 *
 * @group Behavior graph
 */
export type ValueInput = Value | BehaviorValue;

/**
 * Where a chain comes from: an exec output, several (they join), or none
 * yet ({@link BehaviorGraphBuilder.link} connects it later).
 *
 * @group Behavior graph
 */
export type ExecFrom = Exec | readonly Exec[] | undefined;

/**
 * A port of the signature of a function: its type, or its type and its
 * default value.
 *
 * @group Functions
 */
export type SignatureDeclaration =
  BehaviorSignaturePort['type'] | Omit<BehaviorSignaturePort, 'name'>;

/**
 * The id and the label of a node: an id to find it in the debugger, a
 * label for people.
 *
 * @group Behavior graph
 */
export interface NodeOptions {
  readonly id?: NodeId;
  readonly label?: string;
}

/**
 * A node added by a {@link BehaviorGraphBuilder}: its outputs.
 *
 * @group Behavior graph
 */
export class NodeHandle {
  constructor(
    readonly id: NodeId,
    private readonly _outputs: ReadonlyMap<string, BehaviorPortType>,
  ) {}

  /** The exec output `then`. */
  get then(): Exec {
    return this.exec(ThenOutput);
  }

  /** An exec output. */
  exec(port: string): Exec {
    if (this._outputs.get(port) !== 'exec') {
      throw new Error(`Node "${this.id}" has no exec output "${port}"`);
    }
    return new Exec(this.id, port);
  }

  /** A data output: `value` by default. */
  value(port = 'value'): Value {
    const type = this._outputs.get(port);
    if (type === undefined || type === 'exec') {
      throw new Error(`Node "${this.id}" has no data output "${port}"`);
    }
    return new Value(this.id, port, type);
  }
}

/**
 * Builds a behavior graph with handles: each method adds a node, after the
 * exec outputs it is given (`from`), and returns its outputs; `build()`
 * validates the whole.
 *
 * @example
 * ```ts
 * const g = new BehaviorGraphBuilder('guard');
 * g.variable('alert', 'number');
 * const update = g.onUpdate();
 * const seen = g.node('game.seesIntruder');
 * const check = g.branch(update.then, seen.value());
 * g.set(check.exec('true'), 'alert', 1);
 * g.set(check.exec('false'), 'alert',
 *   g.max(g.sub(g.get('alert'), update.value('dt')), 0));
 * const graph = g.build();
 * ```
 *
 * @group Behavior graph
 */
export class BehaviorGraphBuilder {
  private readonly _nodes: BehaviorNode[] = [];
  private readonly _edges: GraphEdge[] = [];
  private _variables: BehaviorVariable[] = [];
  private _events = new Map<string, readonly EventField[]>();
  private _functions: BehaviorFunctionData[] = [];
  // The function whose body this builder makes.
  private _signature: BehaviorFunctionData | undefined;
  private readonly _ids = new Set<NodeId>();
  private _nextId = 1;

  constructor(
    readonly name: string,
    readonly registry: Registry<BehaviorNodeType> = createBehaviorRegistry(),
  ) {}

  // --- Declarations ------------------------------------------------------

  /** Declares a variable of the instances. */
  variable(
    name: string,
    type: BehaviorVariable['type'],
    defaultValue?: BehaviorValue,
  ): this {
    if (this._variables.some((variable) => variable.name === name)) {
      throw new Error(`Variable "${name}" is already declared`);
    }
    this._variables.push({
      name,
      type,
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    });
    return this;
  }

  /**
   * Declares an event and its fields, for {@link on} and {@link emit}.
   * The fields are the outputs of the handlers and the inputs of the
   * emitters.
   */
  event(
    name: string,
    fields: Readonly<Record<string, EventField['type']>> = {},
  ): this {
    if (this._events.has(name)) {
      throw new Error(`Event "${name}" is already declared`);
    }
    this._events.set(
      name,
      Object.entries(fields).map(([field, type]) => ({ name: field, type })),
    );
    return this;
  }

  /**
   * Declares a function or a macro and builds its body with another
   * builder (`f`): its entries are the outputs of `f.inputs()`, its exits
   * the inputs of `f.outputs()`. It reads and sets the variables declared
   * before it, and calls the functions declared before it. Called with
   * {@link call}.
   *
   * @example
   * ```ts
   * g.function('heal', { inputs: { amount: 'number' } }, (f) => {
   *   const start = f.inputs();
   *   const set = f.set(start.exec('exec'), 'health',
   *     f.add(f.get('health'), start.value('amount')));
   *   f.outputs(set.then);
   * });
   * g.call(hit.then, 'heal', { amount: 5 });
   * ```
   */
  function(
    name: string,
    spec: {
      readonly kind?: 'function' | 'macro';
      readonly description?: string;
      readonly inputs?: Readonly<Record<string, SignatureDeclaration>>;
      readonly outputs?: Readonly<Record<string, SignatureDeclaration>>;
    },
    build: (body: BehaviorGraphBuilder) => void,
  ): this {
    if (this._functions.some((fn) => fn.name === name)) {
      throw new Error(`Function "${name}" is already declared`);
    }
    const ports = (
      declared: Readonly<Record<string, SignatureDeclaration>> = {},
    ): BehaviorSignaturePort[] =>
      Object.entries(declared).map(([port, value]) =>
        typeof value === 'string'
          ? { name: port, type: value }
          : { name: port, ...value },
      );
    const signature: BehaviorFunctionData = {
      name,
      ...(spec.kind !== undefined && { kind: spec.kind }),
      ...(spec.description !== undefined && {
        description: spec.description,
      }),
      inputs: ports(spec.inputs),
      outputs: ports(spec.outputs),
      nodes: [],
      edges: [],
    };
    const body = new BehaviorGraphBuilder(name, this.registry);
    body._variables = this._variables;
    body._events = this._events;
    body._functions = [...this._functions];
    body._signature = signature;
    build(body);
    this._functions.push({
      ...signature,
      nodes: [...body._nodes],
      edges: [...body._edges],
    });
    return this;
  }

  /** In the body of a function: its entries, the inputs of its signature. */
  inputs(options?: NodeOptions): NodeHandle {
    this.requireSignature();
    return this.node(FunctionInputs, {}, options);
  }

  /**
   * In the body of a function: its exits, the outputs of its signature.
   * `from` reaches the exit `then` of a function; the exits of a macro by
   * name.
   */
  outputs(
    from: ExecFrom | Readonly<Record<string, ExecFrom>>,
    values: Readonly<Record<string, ValueInput>> = {},
    options?: NodeOptions,
  ): NodeHandle {
    this.requireSignature();
    const exits =
      from === undefined || from instanceof Exec || Array.isArray(from)
        ? { [ThenOutput]: from as ExecFrom }
        : (from as Readonly<Record<string, ExecFrom>>);
    const handle = this.node(FunctionOutputs, { inputs: values }, options);
    for (const [exit, exec] of Object.entries(exits)) {
      this.link(exec, handle, exit);
    }
    return handle;
  }

  /**
   * Calls a function or a macro declared before: after `from` (the entry
   * `exec` of a function; for a macro, its entries by name), its inputs
   * given.
   */
  call(
    from: ExecFrom | Readonly<Record<string, ExecFrom>>,
    name: string,
    inputs: Readonly<Record<string, ValueInput | undefined>> = {},
    options?: NodeOptions,
  ): NodeHandle {
    const entries =
      from === undefined || from instanceof Exec || Array.isArray(from)
        ? { [ExecInput]: from as ExecFrom }
        : (from as Readonly<Record<string, ExecFrom>>);
    const handle = this.node(callType(name), { inputs }, options);
    for (const [entry, exec] of Object.entries(entries)) {
      this.link(exec, handle, entry);
    }
    return handle;
  }

  // --- Events ------------------------------------------------------------

  /** Runs once, when the instance starts. */
  onStart(options?: NodeOptions): NodeHandle {
    return this.node('event.start', {}, options);
  }

  /** Runs at each run of the system; `value('dt')` is its time step. */
  onUpdate(options?: NodeOptions): NodeHandle {
    return this.node('event.update', {}, options);
  }

  /** Runs when an event declared by {@link event} comes; its fields are its values. */
  on(event: string, options?: NodeOptions): NodeHandle {
    return this.node(
      'event.on',
      { params: { event, fields: [...this.fieldsOf(event)] } },
      options,
    );
  }

  /** Sends an event declared by {@link event}, to this instance or `target`. */
  emit(
    from: ExecFrom,
    event: string,
    fields: Readonly<Record<string, ValueInput>> = {},
    target?: ValueInput,
    options?: NodeOptions,
  ): NodeHandle {
    return this.node(
      'event.emit',
      {
        from,
        params: { event, fields: [...this.fieldsOf(event)] },
        inputs: { ...fields, ...(target !== undefined ? { target } : {}) },
      },
      options,
    );
  }

  // --- Flow --------------------------------------------------------------

  /** Goes on by `exec('true')` or `exec('false')`. */
  branch(
    from: ExecFrom,
    condition: ValueInput,
    options?: NodeOptions,
  ): NodeHandle {
    return this.node('flow.branch', { from, inputs: { condition } }, options);
  }

  /** Runs `exec('then0')`, then `exec('then1')`… */
  sequence(from: ExecFrom, count = 2, options?: NodeOptions): NodeHandle {
    return this.node('flow.sequence', { from, params: { count } }, options);
  }

  /** Goes on by `exec(case)`, `exec('default')` for the other values. */
  switch(
    from: ExecFrom,
    value: ValueInput,
    cases: readonly string[],
    options?: NodeOptions,
  ): NodeHandle {
    return this.node(
      'flow.switch',
      { from, params: { cases: [...cases] }, inputs: { value } },
      options,
    );
  }

  /** Goes on the first time only; `reset` opens it again. */
  doOnce(from: ExecFrom, reset?: ExecFrom, options?: NodeOptions): NodeHandle {
    const handle = this.node('flow.doOnce', { from }, options);
    this.link(reset, handle, 'reset');
    return handle;
  }

  /** Runs `exec('body')` for each `value('index')` of [first, last], then `exec('completed')`. */
  forLoop(
    from: ExecFrom,
    first: ValueInput,
    last: ValueInput,
    options?: NodeOptions,
  ): NodeHandle {
    return this.node(
      'flow.forLoop',
      { from, inputs: { first, last } },
      options,
    );
  }

  /** Goes on after some seconds. */
  delay(
    from: ExecFrom,
    seconds: ValueInput,
    options?: NodeOptions,
  ): NodeHandle {
    return this.node('flow.delay', { from, inputs: { seconds } }, options);
  }

  /** Writes a line to the log of the system. */
  log(
    from: ExecFrom,
    text: string,
    value?: ValueInput,
    options?: NodeOptions,
  ): NodeHandle {
    return this.node(
      'debug.log',
      {
        from,
        params: { text },
        inputs: value !== undefined ? { value } : {},
      },
      options,
    );
  }

  // --- Variables ---------------------------------------------------------

  /** The value of a variable. */
  get(name: string): Value {
    return this.node('var.get', {
      params: { name, type: this.variableType(name) },
    }).value();
  }

  /** Sets a variable; `value()` is its new value. */
  set(
    from: ExecFrom,
    name: string,
    value: ValueInput,
    options?: NodeOptions,
  ): NodeHandle {
    return this.node(
      'var.set',
      {
        from,
        params: { name, type: this.variableType(name) },
        inputs: { value },
      },
      options,
    );
  }

  // --- Values ------------------------------------------------------------

  /** A constant, read by many nodes. */
  constant(value: BehaviorValue): Value {
    return this.node('value.constant', {
      params: { type: typeOfConstant(value), value },
    }).value();
  }

  /** `ifTrue` when the condition holds, else `ifFalse`. */
  select(
    condition: ValueInput,
    ifTrue: ValueInput,
    ifFalse: ValueInput,
  ): Value {
    const type = [ifTrue, ifFalse].find((v) => v instanceof Value);
    return this.pure(
      'value.select',
      { condition, ifTrue, ifFalse },
      {
        type:
          type instanceof Value
            ? type.type
            : typeOfConstant(ifTrue as BehaviorValue),
      },
    );
  }

  equals(a: ValueInput, b: ValueInput): Value {
    return this.pure('value.equals', { a, b });
  }

  /** The entity of the instance. */
  self(): Value {
    return this.pure('entity.self', {});
  }

  /** Seconds since the instance started. */
  now(): Value {
    return this.pure('time.now', {});
  }

  add(a: ValueInput, b: ValueInput): Value {
    return this.pure('math.add', { a, b });
  }
  sub(a: ValueInput, b: ValueInput): Value {
    return this.pure('math.sub', { a, b });
  }
  mul(a: ValueInput, b: ValueInput): Value {
    return this.pure('math.mul', { a, b });
  }
  div(a: ValueInput, b: ValueInput): Value {
    return this.pure('math.div', { a, b });
  }
  min(a: ValueInput, b: ValueInput): Value {
    return this.pure('math.min', { a, b });
  }
  max(a: ValueInput, b: ValueInput): Value {
    return this.pure('math.max', { a, b });
  }
  abs(value: ValueInput): Value {
    return this.pure('math.abs', { value });
  }
  clamp(value: ValueInput, min: ValueInput, max: ValueInput): Value {
    return this.pure('math.clamp', { value, min, max });
  }
  lerp(a: ValueInput, b: ValueInput, t: ValueInput): Value {
    return this.pure('math.lerp', { a, b, t });
  }
  /** A number in [min, max), drawn each time it is read. */
  random(min: ValueInput = 0, max: ValueInput = 1): Value {
    return this.pure('math.random', { min, max });
  }
  /** `a op b`: `g.compare(g.get('health'), '<=', 0)`. */
  compare(a: ValueInput, op: CompareOperator, b: ValueInput): Value {
    return this.pure('math.compare', { a, b }, { op });
  }
  and(a: ValueInput, b: ValueInput): Value {
    return this.pure('logic.and', { a, b });
  }
  or(a: ValueInput, b: ValueInput): Value {
    return this.pure('logic.or', { a, b });
  }
  not(value: ValueInput): Value {
    return this.pure('logic.not', { value });
  }

  vec3(x: ValueInput, y: ValueInput, z: ValueInput): Value {
    return this.pure('vec3.make', { x, y, z });
  }
  /** The components of a vector: `.value('x')`… */
  breakVec3(vector: ValueInput): NodeHandle {
    return this.node('vec3.break', { inputs: { vector } });
  }
  addVec3(a: ValueInput, b: ValueInput): Value {
    return this.pure('vec3.add', { a, b });
  }
  subVec3(a: ValueInput, b: ValueInput): Value {
    return this.pure('vec3.sub', { a, b });
  }
  scaleVec3(vector: ValueInput, scale: ValueInput): Value {
    return this.pure('vec3.scale', { vector, scale });
  }
  length(vector: ValueInput): Value {
    return this.pure('vec3.length', { vector });
  }
  distance(a: ValueInput, b: ValueInput): Value {
    return this.pure('vec3.distance', { a, b });
  }
  normalize(vector: ValueInput): Value {
    return this.pure('vec3.normalize', { vector });
  }

  // --- Any node ----------------------------------------------------------

  /**
   * Adds a node of any type of the registry (those of the application):
   * after the exec outputs `from`, its data inputs connected to values or
   * given as constants.
   */
  node(
    type: string,
    spec: {
      readonly from?: ExecFrom;
      readonly inputs?: Readonly<Record<string, ValueInput | undefined>>;
      readonly params?: Readonly<Record<string, unknown>>;
    } = {},
    options: NodeOptions = {},
  ): NodeHandle {
    const definition = this.definition(type);
    const id = options.id ?? this.nextId();
    if (this._ids.has(id)) {
      throw new Error(`Node id "${id}" is already used`);
    }
    this._ids.add(id);
    const params = Object.fromEntries(
      Object.entries(spec.params ?? {}).filter(([, v]) => v !== undefined),
    );
    const defaults: Record<string, BehaviorValue> = {};
    for (const [port, value] of Object.entries(spec.inputs ?? {})) {
      if (value instanceof Value) {
        this._edges.push({
          from: { node: value.node, port: value.port },
          to: { node: id, port },
        });
      } else if (value !== undefined) {
        defaults[port] = value;
      }
    }
    this._nodes.push({
      id,
      type,
      params,
      ...(Object.keys(defaults).length > 0 ? { defaults } : {}),
      ...(options.label !== undefined ? { label: options.label } : {}),
    });
    const outputs = new Map<string, BehaviorPortType>(
      definition
        .outputs(resolveParams(definition.params, params))
        .map((port) => [port.name, port.type]),
    );
    const handle = new NodeHandle(id, outputs);
    this.link(spec.from, handle);
    return handle;
  }

  /**
   * Connects exec outputs to an exec input of a node made before: a chain
   * joining another, a loop back.
   */
  link(from: ExecFrom, to: NodeHandle, entry: string = ExecInput): this {
    const list = from === undefined ? [] : from instanceof Exec ? [from] : from;
    for (const exec of list) {
      this._edges.push({
        from: { node: exec.node, port: exec.port },
        to: { node: to.id, port: entry },
      });
    }
    return this;
  }

  /**
   * Validates the graph and returns it.
   *
   * @throws {@link GraphError} when it has errors.
   */
  build(): BehaviorGraphData {
    const graph: BehaviorGraphData = {
      format: BehaviorGraphFormat,
      version: BehaviorGraphVersion,
      name: this.name,
      nodes: [...this._nodes],
      edges: [...this._edges],
      ...(this._variables.length > 0
        ? { variables: [...this._variables] }
        : {}),
      ...(this._functions.length > 0
        ? { functions: [...this._functions] }
        : {}),
    };
    const validation = validateBehaviorGraph(graph, this.registry);
    if (!validation.valid) {
      throw new GraphError(validation.diagnostics);
    }
    return graph;
  }

  private pure(
    type: string,
    inputs: Readonly<Record<string, ValueInput>>,
    params: Readonly<Record<string, unknown>> = {},
  ): Value {
    return this.node(type, { inputs, params }).value();
  }

  // A node type of the registry, a call of a function declared, or the
  // ports of the function built.
  private definition(type: string): BehaviorNodeType {
    const called = this._functions.find((fn) => callType(fn.name) === type);
    if (called) return callNodeType(called);
    if (
      this._signature &&
      (type === FunctionInputs || type === FunctionOutputs)
    ) {
      return bodyNodeTypes(this._signature).find(
        (body) => body.id === type,
      ) as BehaviorNodeType;
    }
    return this.registry.require(type);
  }

  private requireSignature(): BehaviorFunctionData {
    if (!this._signature) {
      throw new Error('Only the body of a function has inputs and outputs');
    }
    return this._signature;
  }

  private nextId(): NodeId {
    let id: NodeId;
    do {
      id = `n${this._nextId++}`;
    } while (this._ids.has(id));
    return id;
  }

  private variableType(name: string): BehaviorVariable['type'] {
    const variable = this._variables.find((v) => v.name === name);
    if (!variable) {
      throw new Error(`Unknown variable "${name}": declare it first`);
    }
    return variable.type;
  }

  private fieldsOf(event: string): readonly EventField[] {
    const fields = this._events.get(event);
    if (!fields) {
      throw new Error(`Unknown event "${event}": declare it first`);
    }
    return fields;
  }
}

function typeOfConstant(value: BehaviorValue): BehaviorVariable['type'] {
  switch (typeof value) {
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'string':
      return 'string';
    default:
      return 'vec3';
  }
}
