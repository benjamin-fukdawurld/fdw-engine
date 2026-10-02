import type {
  GraphEdge,
  GraphNode,
  MaterialGraphData,
  NodeId,
  PortRef,
  StaticValue,
} from '../graph/MaterialGraphData';
import type { ConstantValue } from '../types/ConstantValue';

// The value connected to an input: another port (possibly swizzled) or a
// literal.
export type InputSource =
  | { readonly ref: PortRef; readonly swizzle?: string }
  | { readonly value: ConstantValue };

// A mutable copy of a graph, transformed by the compiler passes.
export class WorkingGraph {
  readonly name: string;
  readonly nodes = new Map<NodeId, GraphNode>();
  edges: GraphEdge[];
  private _nextId = 0;

  constructor(graph: MaterialGraphData) {
    this.name = graph.name;
    for (const node of graph.nodes) {
      this.nodes.set(node.id, node);
    }
    this.edges = [...graph.edges];
  }

  toData(): MaterialGraphData {
    return {
      format: 'fdw-material-graph',
      version: 1,
      name: this.name,
      nodes: [...this.nodes.values()],
      edges: [...this.edges],
    };
  }

  incoming(node: NodeId): GraphEdge[] {
    return this.edges.filter((edge) => edge.to.node === node);
  }

  // The source of an input of a node, or undefined when it is unconnected
  // and has no node-level default.
  inputSource(node: GraphNode, port: string): InputSource | undefined {
    const edge = this.edges.find(
      (candidate) => candidate.to.node === node.id && candidate.to.port === port
    );
    if (edge) {
      return edge.swizzle === undefined
        ? { ref: edge.from }
        : { ref: edge.from, swizzle: edge.swizzle };
    }
    const value = node.defaults?.[port];
    return value === undefined ? undefined : { value };
  }

  addNode(
    type: string,
    params: Readonly<Record<string, StaticValue>> = {},
    inputs: Readonly<Record<string, InputSource | undefined>> = {}
  ): NodeId {
    let id: NodeId;
    do {
      id = `c${this._nextId++}`;
    } while (this.nodes.has(id));

    const defaults: Record<string, ConstantValue> = {};
    for (const [port, source] of Object.entries(inputs)) {
      if (!source) {
        continue;
      }
      if ('value' in source) {
        defaults[port] = source.value;
      } else {
        this.edges.push({
          from: source.ref,
          to: { node: id, port },
          ...(source.swizzle ? { swizzle: source.swizzle } : {}),
        });
      }
    }

    this.nodes.set(id, {
      id,
      type,
      params,
      ...(Object.keys(defaults).length > 0 ? { defaults } : {}),
    });
    return id;
  }

  removeNode(id: NodeId): void {
    this.nodes.delete(id);
    this.edges = this.edges.filter(
      (edge) => edge.from.node !== id && edge.to.node !== id
    );
  }

  // Makes every use of a node read the same port of another node instead.
  redirectUses(from: NodeId, to: NodeId): void {
    this.edges = this.edges.map((edge) =>
      edge.from.node === from
        ? { ...edge, from: { node: to, port: edge.from.port } }
        : edge
    );
  }
}
