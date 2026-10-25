import type { GraphEdge, GraphNode, NodeId } from './GraphData';

/**
 * A point of the plane of a graph, in the units of its editor (pixels at
 * zoom 1), y down.
 *
 * @group Layout
 */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * A text laid on a graph: an explanation, a reminder.
 *
 * @group Layout
 */
export interface GraphNote {
  readonly id: string;
  /** The top left corner. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly text: string;
}

/**
 * A frame around nodes, with a title: they move with it. Its bounds are
 * those of its nodes.
 *
 * @group Layout
 */
export interface GraphGroup {
  readonly id: string;
  readonly title: string;
  /** A CSS color; the editor's by default. */
  readonly color?: string;
  readonly nodes: readonly NodeId[];
}

/**
 * Where the editor shows the nodes of a graph, and what it adds to them:
 * notes and groups. Kept in the document (`layout`), ignored by the
 * validation and the execution.
 *
 * @group Layout
 */
export interface GraphLayout {
  /** The top left corner of each node, by id. */
  readonly nodes?: Readonly<Record<NodeId, Point>>;
  readonly notes?: readonly GraphNote[];
  readonly groups?: readonly GraphGroup[];
}

/**
 * The nodes and edges of a graph, with their layout: those of a document,
 * or of one of its functions. What the edits change.
 *
 * @group Layout
 */
export interface GraphBody<
  N extends GraphNode = GraphNode,
  E extends GraphEdge = GraphEdge,
> {
  readonly nodes: readonly N[];
  readonly edges: readonly E[];
  readonly layout?: GraphLayout;
}

/**
 * The geometry of the nodes, shared by the editor that draws them and the
 * layout that places them: an input per row on the left, an output per row
 * on the right, under a header.
 *
 * @group Layout
 */
export const NodeGeometry = {
  /** The height of the title. */
  header: 26,
  /** The height of a port. */
  row: 20,
  /** Under the last row. */
  padding: 6,
  minWidth: 140,
  maxWidth: 320,
  /** The width of a character of the texts, as estimated. */
  char: 6.5,
} as const;

/**
 * What the geometry of a node depends on: its title and the names of its
 * ports.
 *
 * @group Layout
 */
export interface NodeShape {
  readonly title: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
}

/**
 * The size of a node: wide enough for its title, and for an input and an
 * output side by side; a row per port.
 *
 * @group Layout
 */
export function nodeSize(shape: NodeShape): { width: number; height: number } {
  const { header, row, padding, minWidth, maxWidth, char } = NodeGeometry;
  const longest = (names: readonly string[]) =>
    names.reduce((max, name) => Math.max(max, name.length), 0);
  const ports = (longest(shape.inputs) + longest(shape.outputs)) * char + 56;
  const title = shape.title.length * char + 40;
  const width = Math.min(
    maxWidth,
    Math.max(minWidth, Math.ceil(Math.max(ports, title) / 10) * 10),
  );
  const rows = Math.max(shape.inputs.length, shape.outputs.length);
  return { width, height: header + rows * row + padding };
}

/**
 * Where a port of a node is: on the left edge for an input, on the right
 * edge for an output, at the middle of its row.
 *
 * @group Layout
 */
export function portPosition(
  position: Point,
  width: number,
  side: 'input' | 'output',
  index: number,
): Point {
  const { header, row } = NodeGeometry;
  return {
    x: side === 'input' ? position.x : position.x + width,
    y: position.y + header + row * index + row / 2,
  };
}

/**
 * Options of {@link autoLayout}.
 *
 * @group Layout
 */
export interface AutoLayoutOptions {
  /** Between two columns. Default 60. */
  readonly columnGap?: number;
  /** Between two nodes of a column. Default 24. */
  readonly rowGap?: number;
  /** The top left corner of the graph. Default (0, 0). */
  readonly origin?: Point;
}

/**
 * Places the nodes of a graph in columns, from its sources to its sinks:
 * the column of a node is the longest path to it (the edges that close a
 * loop left out), pulled to just before the first node it feeds; in a
 * column, the nodes in the mean order of their neighbours. For the graphs
 * made in code, which have no positions.
 *
 * @param shapes - The shape of each node, for its size.
 *
 * @group Layout
 */
export function autoLayout(
  body: Pick<GraphBody, 'nodes' | 'edges'>,
  shapes: ReadonlyMap<NodeId, NodeShape>,
  options: AutoLayoutOptions = {},
): Record<NodeId, Point> {
  const { columnGap = 60, rowGap = 24, origin = { x: 0, y: 0 } } = options;
  const ids = body.nodes.map((node) => node.id);
  const known = new Set(ids);
  const successors = new Map<NodeId, NodeId[]>(ids.map((id) => [id, []]));
  for (const edge of body.edges) {
    if (
      known.has(edge.from.node) &&
      known.has(edge.to.node) &&
      edge.from.node !== edge.to.node
    ) {
      successors.get(edge.from.node)?.push(edge.to.node);
    }
  }

  // The edges of the depth-first walk that do not close a loop, and the
  // nodes in topological order.
  const state = new Map<NodeId, 'open' | 'done'>();
  const forward = new Map<NodeId, NodeId[]>(ids.map((id) => [id, []]));
  const order: NodeId[] = [];
  const visit = (id: NodeId) => {
    state.set(id, 'open');
    for (const next of successors.get(id) ?? []) {
      const seen = state.get(next);
      if (seen === 'open') continue;
      forward.get(id)?.push(next);
      if (!seen) visit(next);
    }
    state.set(id, 'done');
    order.push(id);
  };
  const reached = new Set<NodeId>();
  for (const list of successors.values()) list.forEach((id) => reached.add(id));
  // From the sources first, then whatever is left (loops without source).
  for (const id of [...ids.filter((id) => !reached.has(id)), ...ids]) {
    if (!state.has(id)) visit(id);
  }
  order.reverse();

  const predecessors = new Map<NodeId, NodeId[]>(ids.map((id) => [id, []]));
  for (const [from, list] of forward) {
    for (const to of list) predecessors.get(to)?.push(from);
  }
  const column = new Map<NodeId, number>();
  for (const id of order) {
    const before = predecessors.get(id) ?? [];
    column.set(
      id,
      before.reduce(
        (max, from) => Math.max(max, (column.get(from) ?? 0) + 1),
        0,
      ),
    );
  }
  // A node goes just before the first node it feeds: the values next to
  // where they are read.
  for (const id of [...order].reverse()) {
    const after = forward.get(id) ?? [];
    if (after.length === 0) continue;
    const first = Math.min(...after.map((to) => column.get(to) ?? 0)) - 1;
    if (first > (column.get(id) ?? 0)) column.set(id, first);
  }

  const columns: NodeId[][] = [];
  for (const id of ids) {
    const c = column.get(id) ?? 0;
    (columns[c] ??= []).push(id);
  }
  // The mean place of the neighbours, from left to right, then back.
  const place = new Map<NodeId, number>();
  const rank = () =>
    columns.forEach((list) => list?.forEach((id, i) => place.set(id, i)));
  const sweep = (
    list: NodeId[] | undefined,
    neighbours: Map<NodeId, NodeId[]>,
  ) => {
    if (!list) return;
    const key = new Map<NodeId, number>();
    for (const id of list) {
      const around = (neighbours.get(id) ?? []).filter((n) => place.has(n));
      key.set(
        id,
        around.length > 0
          ? around.reduce((sum, n) => sum + (place.get(n) ?? 0), 0) /
              around.length
          : (place.get(id) ?? 0),
      );
    }
    list.sort((a, b) => (key.get(a) ?? 0) - (key.get(b) ?? 0));
    list.forEach((id, i) => place.set(id, i));
  };
  rank();
  for (let pass = 0; pass < 2; pass++) {
    for (let c = 1; c < columns.length; c++) sweep(columns[c], predecessors);
    for (let c = columns.length - 2; c >= 0; c--) sweep(columns[c], forward);
  }

  const sizes = new Map<NodeId, { width: number; height: number }>();
  for (const id of ids) {
    sizes.set(
      id,
      nodeSize(shapes.get(id) ?? { title: id, inputs: [], outputs: [] }),
    );
  }
  const heights = columns.map((list) =>
    (list ?? []).reduce(
      (sum, id, i) => sum + (sizes.get(id)?.height ?? 0) + (i > 0 ? rowGap : 0),
      0,
    ),
  );
  const tallest = Math.max(0, ...heights);
  const positions: Record<NodeId, Point> = {};
  let x = origin.x;
  columns.forEach((list, c) => {
    if (!list) return;
    // Each column centered on the tallest.
    let y = origin.y + (tallest - heights[c]) / 2;
    let width = 0;
    for (const id of list) {
      const size = sizes.get(id) ?? { width: 0, height: 0 };
      positions[id] = { x, y: Math.round(y) };
      y += size.height + rowGap;
      width = Math.max(width, size.width);
    }
    x += width + columnGap;
  });
  return positions;
}

/**
 * The bounds of nodes placed: the smallest rectangle around them.
 *
 * @group Layout
 */
export function nodesBounds(
  positions: Readonly<Record<NodeId, Point>>,
  sizes: ReadonlyMap<NodeId, { width: number; height: number }>,
  ids: Iterable<NodeId>,
): { x: number; y: number; width: number; height: number } | undefined {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of ids) {
    const position = positions[id];
    const size = sizes.get(id);
    if (!position || !size) continue;
    minX = Math.min(minX, position.x);
    minY = Math.min(minY, position.y);
    maxX = Math.max(maxX, position.x + size.width);
    maxY = Math.max(maxY, position.y + size.height);
  }
  return minX === Infinity
    ? undefined
    : { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
