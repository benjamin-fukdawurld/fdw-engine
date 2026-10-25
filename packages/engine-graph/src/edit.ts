import {
  type GraphEdge,
  type GraphNode,
  type NodeId,
  type PortRef,
  portKey,
} from './GraphData';
import type {
  GraphBody,
  GraphGroup,
  GraphLayout,
  GraphNote,
  Point,
} from './layout';

// The edits of a graph, for its editors: pure functions of a body (the
// nodes, the edges and the layout of a document or of one of its
// functions) returning a new one. The validation is the kind's: an edit
// may make a graph invalid (a node without its required input).

const withLayout = <B extends GraphBody>(body: B, layout: GraphLayout): B => ({
  ...body,
  layout,
});

const sameRef = (a: PortRef, b: PortRef) =>
  a.node === b.node && a.port === b.port;

/**
 * An id no node of the body has: `prefix` followed by the smallest number
 * free (`n12`).
 *
 * @group Edition
 */
export function uniqueNodeId(
  body: Pick<GraphBody, 'nodes'>,
  prefix = 'n',
  taken: ReadonlySet<string> = new Set(),
): NodeId {
  const ids = new Set(body.nodes.map((node) => node.id));
  for (let i = 1; ; i++) {
    const id = `${prefix}${i}`;
    if (!ids.has(id) && !taken.has(id)) return id;
  }
}

/**
 * Adds a node, at a position.
 *
 * @throws when a node has its id.
 * @group Edition
 */
export function addNode<B extends GraphBody>(
  body: B,
  node: B['nodes'][number],
  position?: Point,
): B {
  if (body.nodes.some((other) => other.id === node.id)) {
    throw new Error(`A node "${node.id}" exists already`);
  }
  const layout = body.layout ?? {};
  return {
    ...body,
    nodes: [...body.nodes, node],
    ...(position && {
      layout: { ...layout, nodes: { ...layout.nodes, [node.id]: position } },
    }),
  };
}

/**
 * Removes nodes, the edges that reach them, their positions, their places
 * in the groups (a group left empty goes).
 *
 * @group Edition
 */
export function removeNodes<B extends GraphBody>(
  body: B,
  ids: Iterable<NodeId>,
): B {
  const removed = new Set(ids);
  const layout = body.layout;
  const positions = { ...layout?.nodes };
  for (const id of removed) delete positions[id];
  const groups = layout?.groups
    ?.map((group) => ({
      ...group,
      nodes: group.nodes.filter((id) => !removed.has(id)),
    }))
    .filter((group) => group.nodes.length > 0);
  return {
    ...body,
    nodes: body.nodes.filter((node) => !removed.has(node.id)),
    edges: body.edges.filter(
      (edge) => !removed.has(edge.from.node) && !removed.has(edge.to.node),
    ),
    ...(layout && {
      layout: {
        ...layout,
        nodes: positions,
        ...(groups && { groups }),
      },
    }),
  };
}

/**
 * Which edges a new one replaces: those into its input when the input
 * takes one edge, those from its output when the output feeds one.
 *
 * @group Edition
 */
export interface ConnectOptions {
  readonly replaceInput?: boolean;
  readonly replaceOutput?: boolean;
}

/**
 * Connects an output to an input, replacing the edges the ports cannot
 * keep (see {@link ConnectOptions}); the same edge twice is kept once.
 *
 * @group Edition
 */
export function connect<B extends GraphBody>(
  body: B,
  edge: B['edges'][number],
  { replaceInput = true, replaceOutput = false }: ConnectOptions = {},
): B {
  const kept = body.edges.filter(
    (other) =>
      !(sameRef(other.from, edge.from) && sameRef(other.to, edge.to)) &&
      !(replaceInput && sameRef(other.to, edge.to)) &&
      !(replaceOutput && sameRef(other.from, edge.from)),
  );
  return { ...body, edges: [...kept, edge] };
}

/**
 * Removes edges: those equal to `edges`, or all the edges of a port.
 *
 * @group Edition
 */
export function disconnect<B extends GraphBody>(
  body: B,
  what: readonly GraphEdge[] | { readonly port: PortRef },
): B {
  const keep = (edge: GraphEdge) =>
    'port' in what
      ? !sameRef(edge.from, what.port) && !sameRef(edge.to, what.port)
      : !what.some(
          (other) =>
            sameRef(other.from, edge.from) && sameRef(other.to, edge.to),
        );
  return { ...body, edges: body.edges.filter(keep) };
}

function updateNode<B extends GraphBody>(
  body: B,
  id: NodeId,
  update: (node: B['nodes'][number]) => B['nodes'][number],
): B {
  let found = false;
  const nodes = body.nodes.map((node) => {
    if (node.id !== id) return node;
    found = true;
    return update(node);
  });
  if (!found) throw new Error(`No node "${id}"`);
  return { ...body, nodes };
}

/**
 * Sets parameters of a node; an undefined value removes the parameter
 * (its default applies).
 *
 * @group Edition
 */
export function setParams<B extends GraphBody>(
  body: B,
  id: NodeId,
  params: Readonly<Record<string, unknown>>,
): B {
  return updateNode(body, id, (node) => {
    const next: Record<string, unknown> = { ...node.params };
    for (const [name, value] of Object.entries(params)) {
      if (value === undefined) delete next[name];
      else next[name] = value;
    }
    return { ...node, params: next } as typeof node;
  });
}

/**
 * Sets the value of an input of a node when it is not connected; undefined
 * removes it (the default of the port applies).
 *
 * @group Edition
 */
export function setDefault<B extends GraphBody>(
  body: B,
  id: NodeId,
  port: string,
  value: unknown,
): B {
  return updateNode(body, id, (node) => {
    const defaults: Record<string, unknown> = { ...node.defaults };
    if (value === undefined) delete defaults[port];
    else defaults[port] = value;
    const next: Record<string, unknown> = { ...(node as object), defaults };
    if (Object.keys(defaults).length === 0) delete next['defaults'];
    return next as unknown as typeof node;
  });
}

/**
 * Sets the label of a node; undefined or empty removes it.
 *
 * @group Edition
 */
export function setLabel<B extends GraphBody>(
  body: B,
  id: NodeId,
  label: string | undefined,
): B {
  return updateNode(body, id, (node) => {
    const next: Record<string, unknown> = { ...(node as object), label };
    if (!label) delete next['label'];
    return next as unknown as typeof node;
  });
}

/**
 * Places nodes and notes: their new top left corners, by id.
 *
 * @group Edition
 */
export function moveNodes<B extends GraphBody>(
  body: B,
  positions: Readonly<Record<string, Point>>,
): B {
  const layout = body.layout ?? {};
  const nodes = { ...layout.nodes };
  const ids = new Set(body.nodes.map((node) => node.id));
  for (const [id, position] of Object.entries(positions)) {
    if (ids.has(id)) nodes[id] = { x: position.x, y: position.y };
  }
  const notes = layout.notes?.map((note) => {
    const position = positions[note.id];
    return position ? { ...note, x: position.x, y: position.y } : note;
  });
  return withLayout(body, { ...layout, nodes, ...(notes && { notes }) });
}

/**
 * Adds a note.
 *
 * @group Edition
 */
export function addNote<B extends GraphBody>(body: B, note: GraphNote): B {
  const layout = body.layout ?? {};
  return withLayout(body, {
    ...layout,
    notes: [...(layout.notes ?? []), note],
  });
}

/**
 * Changes a note: its text, its size.
 *
 * @group Edition
 */
export function editNote<B extends GraphBody>(
  body: B,
  id: string,
  change: Partial<Omit<GraphNote, 'id'>>,
): B {
  const layout = body.layout ?? {};
  return withLayout(body, {
    ...layout,
    notes: (layout.notes ?? []).map((note) =>
      note.id === id ? { ...note, ...change } : note,
    ),
  });
}

/**
 * Removes notes and groups (the nodes of a group stay).
 *
 * @group Edition
 */
export function removeDecorations<B extends GraphBody>(
  body: B,
  ids: Iterable<string>,
): B {
  const removed = new Set(ids);
  const layout = body.layout ?? {};
  return withLayout(body, {
    ...layout,
    ...(layout.notes && {
      notes: layout.notes.filter((note) => !removed.has(note.id)),
    }),
    ...(layout.groups && {
      groups: layout.groups.filter((group) => !removed.has(group.id)),
    }),
  });
}

/**
 * Puts nodes in a new group; a node leaves the group it was in.
 *
 * @group Edition
 */
export function groupNodes<B extends GraphBody>(body: B, group: GraphGroup): B {
  const layout = body.layout ?? {};
  const members = new Set(group.nodes);
  const groups = (layout.groups ?? [])
    .map((other) => ({
      ...other,
      nodes: other.nodes.filter((id) => !members.has(id)),
    }))
    .filter((other) => other.nodes.length > 0);
  return withLayout(body, { ...layout, groups: [...groups, group] });
}

/**
 * Changes a group: its title, its color, its nodes.
 *
 * @group Edition
 */
export function editGroup<B extends GraphBody>(
  body: B,
  id: string,
  change: Partial<Omit<GraphGroup, 'id'>>,
): B {
  const layout = body.layout ?? {};
  return withLayout(body, {
    ...layout,
    groups: (layout.groups ?? []).map((group) =>
      group.id === id ? { ...group, ...change } : group,
    ),
  });
}

/**
 * Nodes and the edges between them, copied: what the clipboard holds.
 * Their positions are relative to the first one.
 *
 * @group Edition
 */
export interface GraphFragment<
  N extends GraphNode = GraphNode,
  E extends GraphEdge = GraphEdge,
> {
  readonly nodes: readonly N[];
  readonly edges: readonly E[];
  readonly positions: Readonly<Record<NodeId, Point>>;
  readonly notes?: readonly GraphNote[];
}

/**
 * Copies nodes and notes: the edges between the nodes copied, their
 * positions relative to the top left one.
 *
 * @group Edition
 */
export function copyFragment<N extends GraphNode, E extends GraphEdge>(
  body: GraphBody<N, E>,
  ids: Iterable<string>,
): GraphFragment<N, E> {
  const chosen = new Set(ids);
  const nodes = body.nodes.filter((node) => chosen.has(node.id));
  const notes = (body.layout?.notes ?? []).filter((note) =>
    chosen.has(note.id),
  );
  const kept = new Set(nodes.map((node) => node.id));
  const placed = body.layout?.nodes ?? {};
  const corners = [
    ...nodes.map((node) => placed[node.id] ?? { x: 0, y: 0 }),
    ...notes,
  ];
  const left = Math.min(...corners.map((p) => p.x), Infinity);
  const top = Math.min(...corners.map((p) => p.y), Infinity);
  const origin = {
    x: Number.isFinite(left) ? left : 0,
    y: Number.isFinite(top) ? top : 0,
  };
  const positions: Record<NodeId, Point> = {};
  for (const node of nodes) {
    const at = placed[node.id] ?? origin;
    positions[node.id] = { x: at.x - origin.x, y: at.y - origin.y };
  }
  return {
    nodes,
    edges: body.edges.filter(
      (edge) => kept.has(edge.from.node) && kept.has(edge.to.node),
    ),
    positions,
    ...(notes.length > 0 && {
      notes: notes.map((note) => ({
        ...note,
        x: note.x - origin.x,
        y: note.y - origin.y,
      })),
    }),
  };
}

/**
 * Pastes a fragment with its top left corner at `at`: its nodes and notes
 * get new ids, its edges follow them. Returns the body and the new ids.
 *
 * @group Edition
 */
export function pasteFragment<B extends GraphBody>(
  body: B,
  fragment: GraphFragment<B['nodes'][number], B['edges'][number]>,
  at: Point,
): { body: B; ids: string[] } {
  const renamed = new Map<NodeId, NodeId>();
  const taken = new Set<string>();
  for (const node of fragment.nodes) {
    const id = uniqueNodeId(body, 'n', taken);
    taken.add(id);
    renamed.set(node.id, id);
  }
  const layout = body.layout ?? {};
  const positions = { ...layout.nodes };
  const nodes = fragment.nodes.map((node) => {
    const id = renamed.get(node.id) as NodeId;
    const offset = fragment.positions[node.id] ?? { x: 0, y: 0 };
    positions[id] = { x: at.x + offset.x, y: at.y + offset.y };
    return { ...node, id };
  });
  const edges = fragment.edges.map((edge) => ({
    ...edge,
    from: { ...edge.from, node: renamed.get(edge.from.node) ?? edge.from.node },
    to: { ...edge.to, node: renamed.get(edge.to.node) ?? edge.to.node },
  }));
  const noteIds = new Set((layout.notes ?? []).map((note) => note.id));
  const notes = (fragment.notes ?? []).map((note) => {
    let i = 1;
    while (noteIds.has(`note${i}`)) i++;
    const id = `note${i}`;
    noteIds.add(id);
    return { ...note, id, x: at.x + note.x, y: at.y + note.y };
  });
  return {
    body: {
      ...body,
      nodes: [...body.nodes, ...nodes],
      edges: [...body.edges, ...edges],
      layout: {
        ...layout,
        nodes: positions,
        ...((notes.length > 0 || layout.notes) && {
          notes: [...(layout.notes ?? []), ...notes],
        }),
      },
    },
    ids: [...nodes.map((node) => node.id), ...notes.map((note) => note.id)],
  };
}

/**
 * The edges of a body that reach a port.
 *
 * @group Edition
 */
export function edgesOf(
  body: Pick<GraphBody, 'edges'>,
  port: PortRef,
): GraphEdge[] {
  const key = portKey(port);
  return body.edges.filter(
    (edge) => portKey(edge.from) === key || portKey(edge.to) === key,
  );
}
