import type { Diagnostic } from './Diagnostic';
import {
  type GraphEdge,
  type GraphNode,
  type NodeId,
  portKey,
} from './GraphData';

/**
 * How many edges a port takes: an input takes one by default, an output
 * feeds many. The execution ports of the behavior graphs reverse both: an
 * execution output goes on to one node, an execution input is reached from
 * many.
 *
 * @group Validation
 */
export type PortConnections = 'one' | 'many';

/**
 * A port, as the structural checks see it.
 *
 * @group Validation
 */
export interface PortShape {
  readonly name: string;
  readonly connections?: PortConnections;
}

/**
 * A node whose ports are known: what the structural checks need.
 *
 * @group Validation
 */
export interface NodePorts {
  readonly node: Pick<GraphNode, 'id' | 'type' | 'defaults'>;
  readonly inputs: readonly PortShape[];
  readonly outputs: readonly PortShape[];
}

/**
 * Resolves the nodes of a graph, once each: a duplicate id is an error.
 * `resolve` gives the ports of a node, or undefined when it cannot (after
 * reporting why). Returns the ids seen and the nodes resolved.
 *
 * @group Validation
 */
export function resolveNodes<N extends GraphNode, R>(
  nodes: readonly N[],
  resolve: (node: N) => R | undefined,
  diagnostics: Diagnostic[],
): { seen: Set<NodeId>; resolved: Map<NodeId, R> } {
  const seen = new Set<NodeId>();
  const resolved = new Map<NodeId, R>();
  for (const node of nodes) {
    if (seen.has(node.id)) {
      diagnostics.push({
        severity: 'error',
        node: node.id,
        message: `duplicate node id "${node.id}"`,
      });
      continue;
    }
    seen.add(node.id);
    const result = resolve(node);
    if (result !== undefined) {
      resolved.set(node.id, result);
    }
  }
  return { seen, resolved };
}

/**
 * The edges between ports that exist, each port taking as many edges as
 * its `connections` allow (one per input, many per output by default); the
 * others are reported and left out. `check` adds the checks of a kind of
 * graph (the swizzles of the material graph), after the ports.
 *
 * @group Validation
 */
export function resolveEdges<E extends GraphEdge>(
  edges: readonly E[],
  seen: ReadonlySet<NodeId>,
  nodes: ReadonlyMap<NodeId, NodePorts>,
  diagnostics: Diagnostic[],
  check?: (edge: E, label: string) => Diagnostic | undefined,
): E[] {
  const kept: E[] = [];
  const connected = new Set<string>();
  const feeding = new Set<string>();
  for (const edge of edges) {
    const label = `edge ${edge.from.node}.${edge.from.port} → ${edge.to.node}.${edge.to.port}`;
    if (!seen.has(edge.from.node) || !seen.has(edge.to.node)) {
      diagnostics.push({
        severity: 'error',
        message: `${label} references an unknown node`,
      });
      continue;
    }
    const source = nodes.get(edge.from.node);
    const target = nodes.get(edge.to.node);
    if (!source || !target) {
      // The node itself is invalid and already reported.
      continue;
    }
    const output = source.outputs.find((port) => port.name === edge.from.port);
    if (!output) {
      diagnostics.push({
        severity: 'error',
        node: edge.from.node,
        port: edge.from.port,
        message: `${label}: node type "${source.node.type}" has no output "${edge.from.port}"`,
      });
      continue;
    }
    const input = target.inputs.find((port) => port.name === edge.to.port);
    if (!input) {
      diagnostics.push({
        severity: 'error',
        node: edge.to.node,
        port: edge.to.port,
        message: `${label}: node type "${target.node.type}" has no input "${edge.to.port}"`,
      });
      continue;
    }
    const problem = check?.(edge, label);
    if (problem) {
      diagnostics.push(problem);
      continue;
    }
    const key = portKey(edge.to);
    if (input.connections !== 'many' && connected.has(key)) {
      diagnostics.push({
        severity: 'error',
        node: edge.to.node,
        port: edge.to.port,
        message: 'an input can only receive one edge',
      });
      continue;
    }
    const from = portKey(edge.from);
    if (output.connections === 'one' && feeding.has(from)) {
      diagnostics.push({
        severity: 'error',
        node: edge.from.node,
        port: edge.from.port,
        message: `${label}: output "${edge.from.port}" can only feed one edge`,
      });
      continue;
    }
    connected.add(key);
    feeding.add(from);
    kept.push(edge);
  }
  return kept;
}

/**
 * Warns about the default values of inputs a node does not have.
 *
 * @group Validation
 */
export function checkDefaults(
  nodes: Iterable<NodePorts>,
  diagnostics: Diagnostic[],
): void {
  for (const resolved of nodes) {
    for (const name of Object.keys(resolved.node.defaults ?? {})) {
      if (!resolved.inputs.some((port) => port.name === name)) {
        diagnostics.push({
          severity: 'warning',
          node: resolved.node.id,
          port: name,
          message: `default value for unknown input "${name}"`,
        });
      }
    }
  }
}

/**
 * The nodes in an order where each comes after the nodes feeding it
 * (Kahn's algorithm). Undefined when the graph has a cycle, after
 * reporting the nodes involved.
 *
 * @group Validation
 */
export function topologicalOrder(
  ids: Iterable<NodeId>,
  edges: readonly GraphEdge[],
  diagnostics: Diagnostic[],
): NodeId[] | undefined {
  const inDegree = new Map<NodeId, number>();
  const successors = new Map<NodeId, NodeId[]>();
  for (const id of ids) {
    inDegree.set(id, 0);
    successors.set(id, []);
  }
  for (const edge of edges) {
    inDegree.set(edge.to.node, (inDegree.get(edge.to.node) ?? 0) + 1);
    successors.get(edge.from.node)?.push(edge.to.node);
  }

  // A queue read from an index: shift() would make the sort quadratic.
  const order = [...inDegree.keys()].filter((id) => inDegree.get(id) === 0);
  for (let read = 0; read < order.length; read++) {
    for (const successor of successors.get(order[read]) ?? []) {
      const degree = (inDegree.get(successor) ?? 0) - 1;
      inDegree.set(successor, degree);
      if (degree === 0) {
        order.push(successor);
      }
    }
  }

  if (order.length < inDegree.size) {
    const placed = new Set(order);
    const remaining = [...inDegree.keys()].filter((id) => !placed.has(id));
    const cyclic = cycleNodes(remaining, successors);
    diagnostics.push({
      severity: 'error',
      message: `the graph has a cycle involving nodes ${remaining
        .filter((id) => cyclic.has(id))
        .map((id) => `#${id}`)
        .join(', ')}`,
    });
    return undefined;
  }
  return order;
}

// The nodes on a cycle, among the nodes Kahn's algorithm could not place:
// those also hold the nodes downstream of a cycle. The strongly connected
// components of more than one node, or with a self edge (Tarjan's
// algorithm, iterative so that long chains do not overflow the stack).
function cycleNodes(
  nodes: readonly NodeId[],
  successors: ReadonlyMap<NodeId, readonly NodeId[]>,
): Set<NodeId> {
  const candidates = new Set(nodes);
  const index = new Map<NodeId, number>();
  const low = new Map<NodeId, number>();
  const stack: NodeId[] = [];
  const onStack = new Set<NodeId>();
  const cyclic = new Set<NodeId>();
  let next = 0;

  for (const root of nodes) {
    if (index.has(root)) {
      continue;
    }
    // Each frame: a node and the position of the next successor to visit.
    const frames: { id: NodeId; edge: number }[] = [{ id: root, edge: 0 }];
    index.set(root, next);
    low.set(root, next++);
    stack.push(root);
    onStack.add(root);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const edges = successors.get(frame.id) ?? [];
      if (frame.edge < edges.length) {
        const successor = edges[frame.edge++];
        if (!candidates.has(successor)) {
          continue;
        }
        if (!index.has(successor)) {
          index.set(successor, next);
          low.set(successor, next++);
          stack.push(successor);
          onStack.add(successor);
          frames.push({ id: successor, edge: 0 });
        } else if (onStack.has(successor)) {
          low.set(
            frame.id,
            Math.min(low.get(frame.id) ?? 0, index.get(successor) ?? 0),
          );
        }
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent) {
        low.set(
          parent.id,
          Math.min(low.get(parent.id) ?? 0, low.get(frame.id) ?? 0),
        );
      }
      if (low.get(frame.id) !== index.get(frame.id)) {
        continue;
      }
      const component: NodeId[] = [];
      let member: NodeId;
      do {
        member = stack.pop() as NodeId;
        onStack.delete(member);
        component.push(member);
      } while (member !== frame.id);
      if (component.length > 1 || edges.includes(frame.id)) {
        for (const id of component) {
          cyclic.add(id);
        }
      }
    }
  }
  return cyclic;
}

/**
 * The edges arriving at each node.
 *
 * @group Validation
 */
export function incomingEdges<E extends GraphEdge>(
  edges: readonly E[],
): Map<NodeId, E[]> {
  const incoming = new Map<NodeId, E[]>();
  for (const edge of edges) {
    let list = incoming.get(edge.to.node);
    if (!list) {
      incoming.set(edge.to.node, (list = []));
    }
    list.push(edge);
  }
  return incoming;
}
