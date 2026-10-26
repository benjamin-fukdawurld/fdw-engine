import type {
  GraphEdge,
  GraphNode,
  MaterialGraphData,
  NodeId,
  PortRef,
  StaticValue,
  ValueSource,
} from '../graph/MaterialGraphData';
import { composeSwizzles } from '../graph/swizzle';
import type { ConstantValue } from '../types/ConstantValue';

export type InputSource = ValueSource;

// An edge and its rank in the order of the edges, kept through the
// changes: the order of the edges of toData() does not depend on how the
// graph was transformed.
interface EdgeEntry {
  readonly rank: number;
  readonly edge: GraphEdge;
}

/**
 * A mutable copy of a graph, transformed by the compiler passes. The edges
 * are indexed by the node they lead to and by the node they come from:
 * reading the inputs of a node, removing or redirecting a node cost what
 * its edges cost, not what the whole graph costs.
 */
export class WorkingGraph {
  readonly name: string;
  readonly nodes = new Map<NodeId, GraphNode>();
  /**
   * The node of the graph compiled each node added comes from: the macro or
   * the function it expands (the source maps of an editor).
   */
  readonly origins = new Map<NodeId, NodeId>();
  /** The node being expanded: the origin of the nodes added meanwhile. */
  origin: NodeId | undefined;
  private _nextId = 0;
  private _nextRank = 0;
  // The edges into each node, and the nodes each node has edges to.
  private _incoming = new Map<NodeId, EdgeEntry[]>();
  private _outgoing = new Map<NodeId, Set<NodeId>>();
  private _edges: GraphEdge[] | undefined;

  constructor(graph: MaterialGraphData) {
    this.name = graph.name;
    for (const node of graph.nodes) {
      this.nodes.set(node.id, node);
    }
    this.edges = graph.edges;
  }

  /** The edges, in order. Replacing them reindexes the graph. */
  get edges(): readonly GraphEdge[] {
    if (!this._edges) {
      const entries: EdgeEntry[] = [];
      for (const list of this._incoming.values()) {
        entries.push(...list);
      }
      this._edges = entries
        .sort((a, b) => a.rank - b.rank)
        .map((entry) => entry.edge);
    }
    return this._edges;
  }

  set edges(edges: readonly GraphEdge[]) {
    this._incoming = new Map();
    this._outgoing = new Map();
    this._nextRank = 0;
    for (const edge of edges) {
      this.addEdge(edge);
    }
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
    return (this._incoming.get(node) ?? []).map((entry) => entry.edge);
  }

  /** The nodes a node has edges to. */
  outgoing(node: NodeId): ReadonlySet<NodeId> {
    return this._outgoing.get(node) ?? new Set();
  }

  /**
   * The source of an input of a node, or undefined when it is unconnected
   * and has no node-level default.
   */
  inputSource(node: GraphNode, port: string): InputSource | undefined {
    const edge = this._incoming
      .get(node.id)
      ?.find((candidate) => candidate.edge.to.port === port)?.edge;
    if (edge) {
      return edge.swizzle === undefined
        ? { ref: edge.from }
        : { ref: edge.from, swizzle: edge.swizzle };
    }
    const value = node.defaults?.[port];
    return value === undefined ? undefined : { value };
  }

  private addEdge(edge: GraphEdge, rank = this._nextRank++): void {
    let list = this._incoming.get(edge.to.node);
    if (!list) {
      list = [];
      this._incoming.set(edge.to.node, list);
    }
    list.push({ rank, edge });
    let targets = this._outgoing.get(edge.from.node);
    if (!targets) {
      targets = new Set();
      this._outgoing.set(edge.from.node, targets);
    }
    targets.add(edge.to.node);
    this._edges = undefined;
  }

  addNode(
    type: string,
    params: Readonly<Record<string, StaticValue>> = {},
    inputs: Readonly<Record<string, InputSource | undefined>> = {},
    label?: string,
  ): NodeId {
    let id: NodeId;
    do {
      id = `c${this._nextId++}`;
    } while (this.nodes.has(id));
    if (this.origin !== undefined) this.origins.set(id, this.origin);

    const defaults: Record<string, ConstantValue> = {};
    for (const [port, source] of Object.entries(inputs)) {
      if (!source) {
        continue;
      }
      if ('value' in source) {
        defaults[port] = source.value;
      } else {
        this.addEdge({
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
      ...(label ? { label } : {}),
    });
    return id;
  }

  /** Removes the edges into a node. */
  removeIncoming(id: NodeId): void {
    for (const { edge } of this._incoming.get(id) ?? []) {
      this._outgoing.get(edge.from.node)?.delete(id);
    }
    this._incoming.delete(id);
    this._edges = undefined;
  }

  removeNode(id: NodeId): void {
    this.nodes.delete(id);
    this.removeIncoming(id);
    for (const target of this._outgoing.get(id) ?? []) {
      const list = this._incoming.get(target);
      if (list) {
        this._incoming.set(
          target,
          list.filter((entry) => entry.edge.from.node !== id),
        );
      }
    }
    this._outgoing.delete(id);
    this._edges = undefined;
  }

  // Rewrites the edges coming from a node, in place (their ranks kept).
  private rewriteOutgoing(
    from: NodeId,
    rewrite: (edge: GraphEdge) => GraphEdge,
  ): void {
    const targets = [...(this._outgoing.get(from) ?? [])];
    for (const target of targets) {
      const list = this._incoming.get(target) ?? [];
      let stillFrom = false;
      for (let i = 0; i < list.length; i++) {
        const { edge, rank } = list[i];
        if (edge.from.node !== from) {
          continue;
        }
        const rewritten = rewrite(edge);
        list[i] = { rank, edge: rewritten };
        if (rewritten.from.node === from) {
          stillFrom = true;
        } else {
          let others = this._outgoing.get(rewritten.from.node);
          if (!others) {
            others = new Set();
            this._outgoing.set(rewritten.from.node, others);
          }
          others.add(target);
        }
      }
      if (!stillFrom) {
        this._outgoing.get(from)?.delete(target);
      }
    }
    this._edges = undefined;
  }

  /**
   * Makes every use of an output port read another value instead. Swizzles
   * of the uses are applied on top of the swizzle of the new source.
   */
  redirectPort(
    from: PortRef,
    to: { readonly ref: PortRef; readonly swizzle?: string },
  ): void {
    this.rewriteOutgoing(from.node, (edge) => {
      if (edge.from.port !== from.port) {
        return edge;
      }
      const swizzle = to.swizzle
        ? edge.swizzle
          ? composeSwizzles(to.swizzle, edge.swizzle)
          : to.swizzle
        : edge.swizzle;
      return {
        from: to.ref,
        to: edge.to,
        ...(swizzle ? { swizzle } : {}),
      };
    });
  }

  /** Makes every use of a node read the same port of another node instead. */
  redirectUses(from: NodeId, to: NodeId): void {
    this.rewriteOutgoing(from, (edge) => ({
      ...edge,
      from: { node: to, port: edge.from.port },
    }));
  }
}
