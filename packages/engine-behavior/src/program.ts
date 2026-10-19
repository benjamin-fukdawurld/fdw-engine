import {
  type Diagnostic,
  GraphError,
  type NodeId,
  type Registry,
} from '@fdw/engine-graph';
import {
  type BehaviorGraphData,
  type BehaviorNode,
  type BehaviorValueType,
  type BehaviorVariable,
  zeroOf,
} from './data';
import {
  type BehaviorNodeKind,
  type BehaviorNodeType,
  casesOf,
  createBehaviorRegistry,
} from './nodes';
import { validateBehaviorGraph } from './validate';

/**
 * Where a data input takes its value: the output of a node, or a constant
 * (`node` is -1).
 *
 * @group Execution
 */
export interface DataSource {
  readonly node: number;
  readonly port: string;
  readonly value: unknown;
}

/**
 * Where an exec output goes: a node, by one of its exec inputs.
 *
 * @group Execution
 */
export interface ExecTarget {
  readonly node: number;
  /** The index of the exec input among those of the node. */
  readonly entry: number;
}

/**
 * A node of a {@link BehaviorProgram}: its type, and its ports resolved to
 * indices.
 *
 * @group Execution
 */
export interface ProgramNode {
  readonly index: number;
  readonly id: NodeId;
  readonly node: BehaviorNode;
  readonly type: BehaviorNodeType;
  readonly kind: BehaviorNodeKind;
  /** The parameters, defaults applied. */
  readonly params: Readonly<Record<string, unknown>>;
  /** The data inputs, in the order of the ports, and their sources. */
  readonly inputNames: readonly string[];
  readonly inputs: readonly DataSource[];
  /** The exec inputs, by name. */
  readonly entries: readonly string[];
  /** The exec outputs, by name, and where each goes (if connected). */
  readonly exitNames: readonly string[];
  readonly exits: readonly (ExecTarget | undefined)[];
  /** The data outputs, by name. */
  readonly outputs: readonly string[];
  /** For `flow.switch`: the exit of each case. */
  readonly cases?: ReadonlyMap<string, number>;
  /** `node.label`, else its id. */
  readonly label: string;
}

/**
 * A behavior graph validated and ready to run: its nodes with their ports
 * resolved, its event handlers. What the interpreter and the compiler
 * share.
 *
 * @group Execution
 */
export interface BehaviorProgram {
  readonly graph: BehaviorGraphData;
  readonly nodes: readonly ProgramNode[];
  /** The index of each node, by id. */
  readonly byId: ReadonlyMap<NodeId, number>;
  /** The `event` nodes of each event, in the order of the graph. */
  readonly handlers: ReadonlyMap<string, readonly number[]>;
  readonly variables: readonly BehaviorVariable[];
  /** The warnings of the validation. */
  readonly warnings: readonly Diagnostic[];
}

/**
 * Validates a behavior graph and resolves it for the executors.
 *
 * @throws {@link GraphError} when the graph has errors.
 *
 * @group Execution
 */
export function prepareBehavior(
  graph: BehaviorGraphData,
  registry: Registry<BehaviorNodeType> = createBehaviorRegistry(),
): BehaviorProgram {
  const validation = validateBehaviorGraph(graph, registry);
  if (!validation.valid) {
    throw new GraphError(validation.diagnostics);
  }
  // The nodes in the order of the graph: the handlers of an event run in
  // that order.
  const resolved = graph.nodes.map(
    (node) =>
      validation.nodes.get(node.id) as NonNullable<
        ReturnType<typeof validation.nodes.get>
      >,
  );
  const byId = new Map<NodeId, number>();
  resolved.forEach((r, i) => byId.set(r.node.id, i));

  const nodes = resolved.map((r, index): ProgramNode => {
    const incoming = validation.incoming.get(r.node.id) ?? [];
    const data = r.inputs.filter((port) => port.type !== 'exec');
    const inputs = data.map((port): DataSource => {
      const edge = incoming.find((e) => e.to.port === port.name);
      if (edge) {
        return {
          node: byId.get(edge.from.node) as number,
          port: edge.from.port,
          value: undefined,
        };
      }
      const value =
        r.node.defaults?.[port.name] ??
        port.default ??
        (port.optional ? undefined : zeroOf(port.type as BehaviorValueType));
      return { node: -1, port: port.name, value };
    });
    const entries = r.inputs
      .filter((port) => port.type === 'exec')
      .map((port) => port.name);
    const exitNames = r.outputs
      .filter((port) => port.type === 'exec')
      .map((port) => port.name);
    const exits = exitNames.map((name): ExecTarget | undefined => {
      const edge = validation.edges.find(
        (e) => e.from.node === r.node.id && e.from.port === name,
      );
      if (!edge) {
        return undefined;
      }
      const target = byId.get(edge.to.node) as number;
      return {
        node: target,
        entry: resolved[target].inputs
          .filter((port) => port.type === 'exec')
          .findIndex((port) => port.name === edge.to.port),
      };
    });
    return {
      index,
      id: r.node.id,
      node: r.node,
      type: r.definition as BehaviorNodeType,
      kind: (r.definition as BehaviorNodeType).kind,
      params: r.params,
      inputNames: data.map((port) => port.name),
      inputs,
      entries,
      exitNames,
      exits,
      outputs: r.outputs
        .filter((port) => port.type !== 'exec')
        .map((port) => port.name),
      ...(r.node.type === 'flow.switch'
        ? {
            cases: new Map(
              casesOf(r.params).map((name) => [name, exitNames.indexOf(name)]),
            ),
          }
        : {}),
      label: r.node.label ?? r.node.id,
    };
  });

  const handlers = new Map<string, number[]>();
  for (const node of nodes) {
    if (node.kind === 'event' && node.type.event) {
      const event = node.type.event(node.params);
      let list = handlers.get(event);
      if (!list) {
        handlers.set(event, (list = []));
      }
      list.push(node.index);
    }
  }

  return {
    graph,
    nodes,
    byId,
    handlers,
    variables: graph.variables ?? [],
    warnings: validation.diagnostics,
  };
}

/**
 * Thrown when a graph goes wrong while it runs: a chain longer than the
 * limit of the system (a loop of the flow that never ends), an action
 * returning an exit it does not have.
 *
 * @group Execution
 */
export class BehaviorError extends Error {
  constructor(
    message: string,
    /** The node running. */
    readonly node: NodeId,
    /** The entity of the instance. */
    readonly entity: number,
  ) {
    super(message);
    this.name = 'BehaviorError';
  }
}
