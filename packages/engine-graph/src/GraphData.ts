/**
 * Id of a node, unique in its graph.
 *
 * @group Graph model
 */
export type NodeId = string;

/**
 * A node of a graph: an instance of a node type of a registry. Plain data,
 * serializable as JSON when its parameters and defaults are.
 *
 * @typeParam P - The values of the parameters.
 * @typeParam D - The values of the unconnected inputs.
 *
 * @group Graph model
 */
export interface GraphNode<P = unknown, D = unknown> {
  /** Id of the node, unique in the graph. */
  readonly id: NodeId;
  /** Id of the node type: 'std.mul', 'anim.clip'… */
  readonly type: string;
  /** Parameters of the node, fixed when the graph is built. */
  readonly params: Readonly<Record<string, P>>;
  /** Values of unconnected inputs, overriding the port defaults. */
  readonly defaults?: Readonly<Record<string, D>>;
  /** A name for people: editors, diagnostics, generated code. */
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
}

/**
 * A graph document: typed nodes and the edges between their ports, with
 * the format and the version of the kind of graph (a material, an
 * animation, a behavior).
 *
 * @group Graph model
 */
export interface GraphDocument<
  N extends GraphNode = GraphNode,
  E extends GraphEdge = GraphEdge,
> {
  /** The kind of graph: 'fdw-material-graph', 'fdw-animation-graph'… */
  readonly format: string;
  readonly version: number;
  readonly name: string;
  /** The nodes, in no particular order. */
  readonly nodes: readonly N[];
  /** The connections between the nodes. */
  readonly edges: readonly E[];
}

/**
 * A string identifying a port: `node:port`.
 *
 * @group Graph model
 */
export const portKey = (ref: PortRef): string => `${ref.node}:${ref.port}`;
