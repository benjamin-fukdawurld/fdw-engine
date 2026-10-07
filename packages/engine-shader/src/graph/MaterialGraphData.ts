import type { ConstantValue } from '../types/ConstantValue';
import type { ShaderType } from '../types/ShaderType';

/**
 * Id of a node, unique in its graph.
 *
 * @group Graph model
 */
export type NodeId = string;

/**
 * A compile-time value. Shader types are plain objects, so a graph made of
 * static values stays serializable as JSON.
 *
 * @group Graph model
 */
export type StaticValue =
  | string
  | number
  | boolean
  | readonly number[]
  | ShaderType;

/**
 * A node of a graph: an instance of a {@link NodeDefinition}.
 *
 * @group Graph model
 */
export interface GraphNode {
  /** Id of the node, unique in the graph. */
  readonly id: NodeId;
  /** Id of the NodeDefinition: 'std.mul', 'input.uniform'… */
  readonly type: string;
  /** Compile-time parameters of the node. */
  readonly params: Readonly<Record<string, StaticValue>>;
  /** Values of unconnected inputs, overriding the port defaults. */
  readonly defaults?: Readonly<Record<string, ConstantValue>>;
  /** Used to name the generated variables. */
  readonly label?: string;
}

/**
 * A port of a node.
 *
 * @group Graph model
 */
export interface PortRef {
  readonly node: NodeId;
  readonly port: string;
}

/**
 * Connects an output port to an input port.
 *
 * @group Graph model
 */
export interface GraphEdge {
  /** An output port. */
  readonly from: PortRef;
  /** An input port. */
  readonly to: PortRef;
  /** Applied to the output value: 'xyz', 'x', 'rg'… */
  readonly swizzle?: string;
}

/**
 * A static parameter exposed by the graph (a "feature"), resolved when the
 * material is created: normalMap, alphaMode…
 *
 * @group Graph model
 */
export interface GraphParameterDeclaration {
  /** Name of the parameter, read by the macros. */
  readonly name: string;
  /** Value when the material does not set it. */
  readonly default: StaticValue;
  readonly description?: string;
}

/**
 * Value of the `format` field of serialized graphs.
 *
 * @group Graph model
 */
export const MaterialGraphFormat = 'fdw-material-graph' as const;
/**
 * Current version of the serialized graph format.
 *
 * @group Graph model
 */
export const MaterialGraphVersion = 1 as const;

/**
 * A material graph: a directed acyclic graph of typed nodes.
 *
 * A plain object, serializable as JSON ({@link serializeGraph},
 * {@link parseGraph}). Build it with a {@link GraphBuilder}.
 *
 * @group Graph model
 */
export interface MaterialGraphData {
  readonly format: typeof MaterialGraphFormat;
  readonly version: typeof MaterialGraphVersion;
  readonly name: string;
  /** The nodes, in no particular order. */
  readonly nodes: readonly GraphNode[];
  /** The connections between the nodes. */
  readonly edges: readonly GraphEdge[];
  /** Static parameters declared by the graph. */
  readonly parameters?: readonly GraphParameterDeclaration[];
}

/**
 * A string identifying a port: `node:port`.
 *
 * @group Graph model
 */
export const portKey = (ref: PortRef): string => `${ref.node}:${ref.port}`;

/**
 * A value feeding an input: an output port (possibly swizzled) or a literal.
 *
 * @group Graph model
 */
export type ValueSource =
  | { readonly ref: PortRef; readonly swizzle?: string }
  | { readonly value: ConstantValue };
