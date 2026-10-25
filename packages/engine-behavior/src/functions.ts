import {
  type Diagnostic,
  type GraphEdge,
  type NodeId,
  type PortRef,
  type PortSpec,
  Registry,
} from '@fdw/engine-graph';
import {
  type BehaviorFunctionData,
  type BehaviorGraphData,
  type BehaviorNode,
  type BehaviorPortType,
  type BehaviorSignaturePort,
  type BehaviorValueType,
  zeroOf,
} from './data';
import {
  type BehaviorNodeType,
  ExecInput,
  execIn,
  execOut,
  ThenOutput,
} from './nodes';

/**
 * The node type of the entries of a function or a macro, in its body: an
 * output per input of its signature.
 *
 * @group Functions
 */
export const FunctionInputs = 'fn.inputs';

/**
 * The node type of the exits of a function or a macro, in its body: an
 * input per output of its signature.
 *
 * @group Functions
 */
export const FunctionOutputs = 'fn.outputs';

/**
 * The prefix of the node types calling the functions: `call.<name>`.
 *
 * @group Functions
 */
export const CallPrefix = 'call.';

/**
 * The node type calling a function or a macro.
 *
 * @group Functions
 */
export const callType = (name: string): string => `${CallPrefix}${name}`;

/**
 * The function or the macro of a graph, by name.
 *
 * @group Functions
 */
export function functionOf(
  graph: Pick<BehaviorGraphData, 'functions'>,
  name: string,
): BehaviorFunctionData | undefined {
  return graph.functions?.find((fn) => fn.name === name);
}

/**
 * The signature of a function as ports: those of the macros as declared,
 * those of a function with its entry (`exec`) and its exit (`then`) of the
 * flow.
 *
 * @group Functions
 */
export function signatureOf(fn: BehaviorFunctionData): {
  readonly inputs: readonly BehaviorSignaturePort[];
  readonly outputs: readonly BehaviorSignaturePort[];
} {
  if (fn.kind === 'macro') return fn;
  return {
    inputs: [{ name: ExecInput, type: 'exec' }, ...fn.inputs],
    outputs: [{ name: ThenOutput, type: 'exec' }, ...fn.outputs],
  };
}

const inputPort = (port: BehaviorSignaturePort): PortSpec<BehaviorPortType> =>
  port.type === 'exec'
    ? execIn(port.name)
    : {
        name: port.name,
        type: port.type,
        default: port.default ?? zeroOf(port.type),
      };

const outputPort = (port: BehaviorSignaturePort): PortSpec<BehaviorPortType> =>
  port.type === 'exec'
    ? execOut(port.name)
    : { name: port.name, type: port.type };

/**
 * The node type calling a function or a macro: its signature as ports.
 *
 * @group Functions
 */
export function callNodeType(fn: BehaviorFunctionData): BehaviorNodeType {
  const { inputs, outputs } = signatureOf(fn);
  const entries = inputs.map(inputPort);
  const exits = outputs.map(outputPort);
  const flows = [...inputs, ...outputs].some((port) => port.type === 'exec');
  return {
    id: callType(fn.name),
    // A macro without entry nor exit is computed on demand.
    kind: flows ? 'flow' : 'pure',
    category: fn.kind === 'macro' ? 'macro' : 'function',
    description:
      fn.description ??
      `Calls the ${fn.kind === 'macro' ? 'macro' : 'function'} "${fn.name}".`,
    function: fn.name,
    inputs: () => entries,
    outputs: () => exits,
  };
}

/**
 * The node types of the body of a function: its `fn.inputs` (the inputs of
 * the signature as outputs) and its `fn.outputs` (the outputs as inputs).
 *
 * @group Functions
 */
export function bodyNodeTypes(fn: BehaviorFunctionData): BehaviorNodeType[] {
  const { inputs, outputs } = signatureOf(fn);
  const entries = inputs.map(outputPort);
  const exits = outputs.map((port) =>
    port.type === 'exec'
      ? execIn(port.name)
      : { name: port.name, type: port.type, optional: true },
  );
  return [
    {
      id: FunctionInputs,
      kind: 'pure',
      category: 'function',
      description: `The inputs of "${fn.name}".`,
      function: fn.name,
      inputs: () => [],
      outputs: () => entries,
    },
    {
      id: FunctionOutputs,
      kind: 'pure',
      category: 'function',
      description: `The outputs of "${fn.name}".`,
      function: fn.name,
      inputs: () => exits,
      outputs: () => [],
    },
  ];
}

/**
 * A registry with the node types of `base` and those calling the functions
 * of the graph; with the ports of the body of `body` when given.
 *
 * @group Functions
 */
export function functionRegistry(
  graph: Pick<BehaviorGraphData, 'functions'>,
  base: Registry<BehaviorNodeType>,
  body?: BehaviorFunctionData,
): Registry<BehaviorNodeType> {
  if (!graph.functions?.length && !body) return base;
  const types: BehaviorNodeType[] = [...base.definitions];
  for (const fn of graph.functions ?? []) {
    if (!base.has(callType(fn.name))) types.push(callNodeType(fn));
  }
  if (body) types.push(...bodyNodeTypes(body));
  return new Registry(types);
}

/**
 * The checks of the functions themselves: their names, their signatures,
 * their bodies (one `fn.inputs` and one `fn.outputs` at most, no event, no
 * delay in a function). Their nodes are checked by the validation of the
 * graph.
 *
 * @group Functions
 */
export function checkFunctions(
  graph: Pick<BehaviorGraphData, 'functions'>,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const names = new Set<string>();
  for (const fn of graph.functions ?? []) {
    const error = (message: string, node?: NodeId) =>
      diagnostics.push({
        severity: 'error',
        scope: fn.name,
        message,
        ...(node !== undefined && { node }),
      });
    if (!/^[A-Za-z_][\w-]*$/.test(fn.name)) {
      error(`"${fn.name}" cannot name a function`);
    }
    if (names.has(fn.name)) error(`function "${fn.name}" is declared twice`);
    names.add(fn.name);
    const { inputs, outputs } = signatureOf(fn);
    for (const [side, ports] of [
      ['input', inputs],
      ['output', outputs],
    ] as const) {
      const seen = new Set<string>();
      for (const port of ports) {
        if (seen.has(port.name)) error(`${side} "${port.name}" is given twice`);
        seen.add(port.name);
        if (fn.kind !== 'macro' && port.type === 'exec' && seen.size > 1) {
          error(
            `a function has one entry and one exit: "${port.name}" cannot be exec`,
          );
        }
      }
    }
    const count = (type: string) =>
      fn.nodes.filter((node) => node.type === type);
    for (const type of [FunctionInputs, FunctionOutputs]) {
      const found = count(type);
      if (found.length > 1) {
        error(`a body has one "${type}" node at most`, found[1].id);
      }
    }
    for (const node of fn.nodes) {
      if (node.type.startsWith('event.') && node.type !== 'event.emit') {
        error('a function does not handle events: call it from them', node.id);
      }
      if (fn.kind !== 'macro' && node.type === 'flow.delay') {
        error('a function cannot wait: make it a macro', node.id);
      }
    }
  }
  return diagnostics;
}

/**
 * Lays the functions in the graph: each `call.<name>` node replaced by the
 * nodes of the body of its function, with the ids `<call>/<node>`, the
 * edges of the call joined to those of the body (through its `fn.inputs`
 * and `fn.outputs` nodes), the inputs of the call not connected given to
 * the nodes that read them. The functions a body calls are laid in turn.
 *
 * @throws when a function calls itself, directly or not.
 * @group Functions
 */
export function expandFunctions(graph: BehaviorGraphData): BehaviorGraphData {
  if (!graph.functions?.length) return graph;
  const functions = new Map(graph.functions.map((fn) => [fn.name, fn]));
  const nameOfCall = (node: BehaviorNode) =>
    node.type.startsWith(CallPrefix) &&
    functions.has(node.type.slice(CallPrefix.length))
      ? node.type.slice(CallPrefix.length)
      : undefined;

  const expand = (
    nodes: readonly BehaviorNode[],
    edges: readonly GraphEdge[],
    stack: readonly string[],
  ): { nodes: BehaviorNode[]; edges: GraphEdge[] } => {
    let outNodes: BehaviorNode[] = [...nodes];
    let outEdges: GraphEdge[] = [...edges];
    for (const call of nodes) {
      const name = nameOfCall(call);
      if (name === undefined) continue;
      if (stack.includes(name)) {
        throw new Error(
          `Function "${name}" calls itself: ${[...stack, name].join(' → ')}`,
        );
      }
      const fn = functions.get(name) as BehaviorFunctionData;
      const { inputs } = signatureOf(fn);
      const body = expand(fn.nodes, fn.edges, [...stack, name]);
      const entry = body.nodes.find((node) => node.type === FunctionInputs);
      const exit = body.nodes.find((node) => node.type === FunctionOutputs);
      const prefix = `${call.id}/`;
      const inner = (id: NodeId) => `${prefix}${id}`;
      const isEntry = (id: NodeId) => id === entry?.id;
      const isExit = (id: NodeId) => id === exit?.id;

      // The edges into the call, by its input; those out of it, by its
      // output.
      const into = new Map<string, GraphEdge[]>();
      const outOf = new Map<string, GraphEdge[]>();
      for (const edge of outEdges) {
        if (edge.to.node === call.id) {
          into.set(edge.to.port, [...(into.get(edge.to.port) ?? []), edge]);
        }
        if (edge.from.node === call.id) {
          outOf.set(edge.from.port, [
            ...(outOf.get(edge.from.port) ?? []),
            edge,
          ]);
        }
      }
      // The value of an input of the call, when nothing feeds it.
      const constant = (port: string) => {
        const declared = inputs.find((input) => input.name === port);
        return (
          call.defaults?.[port] ??
          declared?.default ??
          zeroOf((declared?.type ?? 'number') as BehaviorValueType)
        );
      };

      const laid: BehaviorNode[] = body.nodes
        .filter((node) => !isEntry(node.id) && !isExit(node.id))
        .map((node) => ({ ...node, id: inner(node.id) }));
      // The values given to the nodes whose input nothing feeds anymore.
      const defaults = new Map<NodeId, Record<string, unknown>>();
      const give = (to: PortRef, value: unknown) => {
        const values = defaults.get(to.node) ?? {};
        values[to.port] = value;
        defaults.set(to.node, values);
      };
      const joined: GraphEdge[] = [];
      const reached = new Set<string>();
      for (const edge of body.edges) {
        const fromEntry = isEntry(edge.from.node);
        const toExit = isExit(edge.to.node);
        if (toExit) reached.add(edge.to.port);
        // Where the edge starts and ends outside the body: the edges of the
        // ports of the call.
        const sources = fromEntry
          ? (into.get(edge.from.port) ?? []).map((e) => e.from)
          : [{ node: inner(edge.from.node), port: edge.from.port }];
        const targets = toExit
          ? (outOf.get(edge.to.port) ?? []).map((e) => e.to)
          : [{ node: inner(edge.to.node), port: edge.to.port }];
        if (fromEntry && sources.length === 0) {
          // A data input of the call not connected: its value.
          const declared = inputs.find((port) => port.name === edge.from.port);
          if (declared?.type !== 'exec') {
            for (const to of targets) give(to, constant(edge.from.port));
          }
          continue;
        }
        for (const from of sources) {
          for (const to of targets) joined.push({ ...edge, from, to });
        }
      }
      // An output of the call the body does not give: the zero of its type.
      for (const port of signatureOf(fn).outputs) {
        if (port.type === 'exec' || reached.has(port.name)) continue;
        for (const edge of outOf.get(port.name) ?? []) {
          give(edge.to, zeroOf(port.type));
        }
      }

      outNodes = [
        ...outNodes.filter((node) => node.id !== call.id),
        ...laid,
      ].map((node) => {
        const values = defaults.get(node.id);
        return values
          ? { ...node, defaults: { ...node.defaults, ...values } }
          : node;
      }) as BehaviorNode[];
      outEdges = [
        ...outEdges.filter(
          (edge) => edge.from.node !== call.id && edge.to.node !== call.id,
        ),
        ...joined,
      ];
    }
    return { nodes: outNodes, edges: outEdges };
  };

  const flat = expand(graph.nodes, graph.edges, []);
  const expanded: BehaviorGraphData = {
    ...graph,
    nodes: flat.nodes,
    edges: flat.edges,
  };
  delete (expanded as { functions?: unknown }).functions;
  return expanded;
}
