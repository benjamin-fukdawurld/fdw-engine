import type { Diagnostic } from '../graph/Diagnostic';
import type { NodeTypes } from '../graph/inference';
import type { NodeId } from '../graph/MaterialGraphData';
import { typeToString } from '../types/ShaderType';
import type { WorkingGraph } from './WorkingGraph';

/** A fold loop of a graph: its loop.end and the nodes of its body. */
export interface FoldLoop {
  readonly end: NodeId;
  /** The loop.state and loop.index nodes of the loop, if any. */
  readonly state?: NodeId;
  readonly index?: NodeId;
  /**
   * The nodes computed at each iteration: those depending on the state or
   * the index through a path that does not cross the end, the state and
   * the index included. The bodies of the loops nested in it too.
   */
  readonly body: ReadonlySet<NodeId>;
  /** The number of loops it is nested in. */
  readonly depth: number;
}

/** The fold loops of a graph. */
export interface LoopAnalysis {
  /** By the id of their loop.end node, outer loops first. */
  readonly loops: ReadonlyMap<NodeId, FoldLoop>;
  /** The innermost loop computing each node of a body: its loop.end. */
  readonly owner: ReadonlyMap<NodeId, NodeId>;
}

// The nodes that end a graph: a loop body cannot reach them.
const rootTypes = new Set([
  'output.vertex',
  'output.fragment',
  'output.target',
  'output.compute',
  'write.storage',
]);

/**
 * Finds the fold loops of a graph (loop.end nodes) and their bodies, and
 * checks them: each loop.state and loop.index tied to a single loop.end,
 * the body reaching the outputs only through its end, the initial state
 * and the count computed outside of it, loops nested in one another only.
 */
export function analyzeLoops(
  graph: WorkingGraph,
  types: ReadonlyMap<NodeId, NodeTypes>,
  diagnostics: Diagnostic[],
): LoopAnalysis {
  const error = (node: NodeId, message: string) =>
    diagnostics.push({ severity: 'error', node, message });
  const outgoing = new Map<NodeId, NodeId[]>();
  for (const edge of graph.edges) {
    let targets = outgoing.get(edge.from.node);
    if (!targets) {
      targets = [];
      outgoing.set(edge.from.node, targets);
    }
    targets.push(edge.to.node);
  }

  // The loop.state and loop.index tied to each end.
  const ends = [...graph.nodes.values()].filter(
    (node) => node.type === 'loop.end',
  );
  const tiedTo = new Map<NodeId, NodeId>();
  const parts = new Map<NodeId, { state?: NodeId; index?: NodeId }>();
  for (const end of ends) {
    const found: { state?: NodeId; index?: NodeId } = {};
    for (const [port, type] of [
      ['state', 'loop.state'],
      ['index', 'loop.index'],
    ] as const) {
      const source = graph.inputSource(end, port);
      if (!source) {
        continue;
      }
      const node =
        'ref' in source ? graph.nodes.get(source.ref.node) : undefined;
      if (!node || node.type !== type || ('ref' in source && source.swizzle)) {
        error(end.id, `the ${port} of a loop.end must be a ${type} node`);
        continue;
      }
      const other = tiedTo.get(node.id);
      if (other !== undefined) {
        error(node.id, `${type} is tied to two loops (#${other}, #${end.id})`);
        continue;
      }
      tiedTo.set(node.id, end.id);
      found[port] = node.id;
    }
    if (found.state === undefined) {
      error(end.id, 'a loop.end needs its loop.state');
    }
    parts.set(end.id, found);
    const type = types.get(end.id)?.outputs['result'];
    if (
      type &&
      ((type.kind !== 'scalar' && type.kind !== 'vector') ||
        type.scalar === 'bool' ||
        type.scalar === 'f16')
    ) {
      error(
        end.id,
        `the state of a loop must be a f32, i32 or u32 scalar or vector, got ${typeToString(
          type,
        )}`,
      );
    }
  }
  for (const node of graph.nodes.values()) {
    if (
      (node.type === 'loop.state' || node.type === 'loop.index') &&
      !tiedTo.has(node.id)
    ) {
      error(node.id, `${node.type} is not tied to a loop.end`);
    }
  }

  // The bodies: from the state and the index, up to the end.
  const bodies = new Map<NodeId, Set<NodeId>>();
  for (const end of ends) {
    const { state, index } = parts.get(end.id) ?? {};
    const body = new Set<NodeId>();
    const pending = [state, index].filter(
      (id): id is NodeId => id !== undefined,
    );
    while (pending.length > 0) {
      const id = pending.pop() as NodeId;
      if (id === end.id || body.has(id)) {
        continue;
      }
      body.add(id);
      pending.push(...(outgoing.get(id) ?? []));
    }
    bodies.set(end.id, body);
    for (const id of body) {
      const type = graph.nodes.get(id)?.type ?? '';
      if (rootTypes.has(type)) {
        error(
          id,
          `depends on the loop.state of #${end.id} without going through its loop.end`,
        );
      } else if (type === 'light.current' || type === 'light.sum') {
        error(id, `${type} cannot be in the body of a fold loop`);
      }
    }
    for (const port of ['initial', 'count']) {
      const source = graph.inputSource(end, port);
      if (source && 'ref' in source && body.has(source.ref.node)) {
        error(end.id, `the ${port} of a loop cannot depend on its state`);
      }
    }
  }

  // Nesting: a loop whose end is in the body of another runs inside it.
  const depth = new Map<NodeId, number>();
  for (const end of ends) {
    let count = 0;
    for (const [other, body] of bodies) {
      if (other === end.id || !body.has(end.id)) {
        continue;
      }
      if (bodies.get(end.id)?.has(other)) {
        error(
          end.id,
          `the loops #${end.id} and #${other} depend on each other`,
        );
      }
      count++;
    }
    depth.set(end.id, count);
  }
  const owner = new Map<NodeId, NodeId>();
  for (const [end, body] of bodies) {
    for (const id of body) {
      const current = owner.get(id);
      if (current === undefined) {
        owner.set(id, end);
        continue;
      }
      const [inner, outer] =
        (depth.get(end) ?? 0) > (depth.get(current) ?? 0)
          ? [end, current]
          : [current, end];
      if (!bodies.get(outer)?.has(inner) || inner === outer) {
        error(
          id,
          `depends on the states of two loops that are not nested (#${current}, #${end})`,
        );
        continue;
      }
      owner.set(id, inner);
    }
  }

  const loops = new Map<NodeId, FoldLoop>();
  for (const end of [...ends].sort(
    (a, b) => (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0),
  )) {
    loops.set(end.id, {
      end: end.id,
      ...parts.get(end.id),
      body: bodies.get(end.id) as Set<NodeId>,
      depth: depth.get(end.id) ?? 0,
    });
  }
  return { loops, owner };
}
