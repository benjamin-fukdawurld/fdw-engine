import { type Diagnostic, hasNoError } from './Diagnostic';
import type { GraphDocument, GraphEdge, GraphNode, NodeId } from './GraphData';
import {
  basicParamCheck,
  checkParams,
  type ParamCheck,
  type ParamSchema,
  resolveParams,
} from './params';
import type { Registry } from './Registry';
import {
  checkDefaults,
  incomingEdges,
  resolveEdges,
  resolveNodes,
  topologicalOrder,
} from './structure';

/**
 * A port of a node type, of a type of the kind of graph ('pose',
 * 'number'… for the animation graphs).
 *
 * @group Node types
 */
export interface PortSpec<T = string> {
  readonly name: string;
  readonly type: T;
  /** Value used when the input is not connected. */
  readonly default?: unknown;
  /** An optional input can stay unconnected without a default value. */
  readonly optional?: boolean;
  readonly description?: string;
}

/**
 * A node type: its parameters, and its ports, which can depend on them.
 *
 * @group Node types
 */
export interface NodeType<T = string> {
  /** 'anim.clip', 'anim.blend'… */
  readonly id: string;
  /** For documentation and editors: 'source', 'blend', 'output'… */
  readonly category?: string;
  readonly description?: string;
  readonly params?: Readonly<Record<string, ParamSchema>>;
  inputs(params: Readonly<Record<string, unknown>>): readonly PortSpec<T>[];
  outputs(params: Readonly<Record<string, unknown>>): readonly PortSpec<T>[];
}

/**
 * A node with its type, its parameters (defaults applied) and its ports.
 *
 * @group Validation
 */
export interface ResolvedGraphNode<
  T = string,
  N extends GraphNode = GraphNode,
> {
  readonly node: N;
  readonly definition: NodeType<T>;
  readonly params: Readonly<Record<string, unknown>>;
  readonly inputs: readonly PortSpec<T>[];
  readonly outputs: readonly PortSpec<T>[];
}

/**
 * Result of {@link validateDocument}.
 *
 * @group Validation
 */
export interface DocumentValidation<
  T = string,
  N extends GraphNode = GraphNode,
  E extends GraphEdge = GraphEdge,
> {
  /** True when no diagnostic is an error. */
  readonly valid: boolean;
  readonly diagnostics: readonly Diagnostic[];
  /** The nodes that could be resolved. */
  readonly nodes: ReadonlyMap<NodeId, ResolvedGraphNode<T, N>>;
  /** The valid edges. */
  readonly edges: readonly E[];
  /** The edges arriving at each node. */
  readonly incoming: ReadonlyMap<NodeId, readonly E[]>;
  /** Each node after those feeding it; empty when the graph has a cycle. */
  readonly order: readonly NodeId[];
}

/**
 * How {@link validateDocument} checks a kind of graph.
 *
 * @group Validation
 */
export interface ValidationRules<T = string, N extends GraphNode = GraphNode> {
  readonly registry: Registry<NodeType<T>>;
  /** Whether an output of type `from` can feed an input of type `to` (equality by default). */
  readonly accepts?: (from: T, to: T) => boolean;
  /** The name of a type in the messages (`String` by default). */
  readonly typeName?: (type: T) => string;
  /** Checks the parameters of the other kinds than the basic ones. */
  readonly param?: ParamCheck;
  /**
   * Checks the graph as a whole, its nodes resolved: its outputs, the
   * names its nodes declare.
   */
  readonly graph?: (
    nodes: ReadonlyMap<NodeId, ResolvedGraphNode<T, N>>,
    diagnostics: Diagnostic[],
  ) => void;
}

/**
 * Validates a graph of simply typed ports: node types and parameters,
 * edges, port types, unconnected inputs without default, cycles, then the
 * checks of its kind. Does not throw: the problems are in `diagnostics`.
 *
 * @group Validation
 */
export function validateDocument<T, N extends GraphNode, E extends GraphEdge>(
  graph: GraphDocument<N, E>,
  rules: ValidationRules<T, N>,
): DocumentValidation<T, N, E> {
  const diagnostics: Diagnostic[] = [];
  const accepts = rules.accepts ?? ((from: T, to: T) => from === to);
  const typeName = rules.typeName ?? ((type: T) => String(type));
  const check: ParamCheck = (name, schema, value) =>
    basicParamCheck(name, schema, value) ?? rules.param?.(name, schema, value);

  const { seen, resolved: nodes } = resolveNodes(
    graph.nodes,
    (node): ResolvedGraphNode<T, N> | undefined => {
      const definition = rules.registry.get(node.type);
      if (!definition) {
        diagnostics.push({
          severity: 'error',
          node: node.id,
          message: `unknown node type "${node.type}"`,
        });
        return undefined;
      }
      if (!checkParams(node, definition.params ?? {}, check, diagnostics)) {
        return undefined;
      }
      const params = resolveParams(definition.params, node.params);
      try {
        return {
          node,
          definition,
          params,
          inputs: definition.inputs(params),
          outputs: definition.outputs(params),
        };
      } catch (error) {
        diagnostics.push({
          severity: 'error',
          node: node.id,
          message: `cannot resolve the ports: ${(error as Error).message}`,
        });
        return undefined;
      }
    },
    diagnostics,
  );

  const edges = resolveEdges(graph.edges, seen, nodes, diagnostics, (edge) => {
    const from = nodes
      .get(edge.from.node)
      ?.outputs.find((port) => port.name === edge.from.port);
    const to = nodes
      .get(edge.to.node)
      ?.inputs.find((port) => port.name === edge.to.port);
    if (from && to && !accepts(from.type, to.type)) {
      return {
        severity: 'error',
        node: edge.to.node,
        port: edge.to.port,
        message: `expected ${typeName(to.type)}, got ${typeName(
          from.type,
        )} from #${edge.from.node}.${edge.from.port}`,
      };
    }
    return undefined;
  });
  checkDefaults(nodes.values(), diagnostics);

  const incoming = incomingEdges(edges);
  for (const resolved of nodes.values()) {
    const connected = new Set(
      (incoming.get(resolved.node.id) ?? []).map((edge) => edge.to.port),
    );
    for (const input of resolved.inputs) {
      if (
        !connected.has(input.name) &&
        !input.optional &&
        input.default === undefined &&
        resolved.node.defaults?.[input.name] === undefined
      ) {
        diagnostics.push({
          severity: 'error',
          node: resolved.node.id,
          port: input.name,
          message: `input "${input.name}" is not connected and has no default`,
        });
      }
    }
  }

  rules.graph?.(nodes, diagnostics);
  const order = topologicalOrder(nodes.keys(), edges, diagnostics) ?? [];
  return {
    valid: hasNoError(diagnostics),
    diagnostics,
    nodes,
    edges,
    incoming,
    order,
  };
}
