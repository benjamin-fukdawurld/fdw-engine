import {
  type GraphEdge,
  type GraphGroup,
  NodeGeometry,
  nodeSize,
  type Point,
  portPosition,
  type PortRef,
} from '@fdw/engine-graph';
import type { GraphView, NodeView } from '@fdw/engine-graph-editing';

// The geometry of the canvas, from that of engine-graph: the editor draws
// the nodes at the size the layout gives them, so that the wires reach
// their ports without measuring the page.

/** The size of a node as drawn. */
export const sizeOf = (node: NodeView): { width: number; height: number } =>
  nodeSize({
    title: node.title,
    inputs: node.inputs.map((port) => port.name),
    outputs: node.outputs.map((port) => port.name),
  });

/** A string identifying an edge. */
export const edgeKey = (edge: GraphEdge): string =>
  `${edge.from.node}:${edge.from.port}>${edge.to.node}:${edge.to.port}`;

/** The place of a node, at the origin when it has none. */
export const positionOf = (
  view: GraphView,
  id: string,
  moved?: ReadonlyMap<string, Point>,
): Point => moved?.get(id) ?? view.layout.nodes?.[id] ?? { x: 0, y: 0 };

/** Where a port of a node is, in the plane of the graph. */
export function portPoint(
  node: NodeView,
  position: Point,
  side: 'input' | 'output',
  port: string,
): Point | undefined {
  const ports = side === 'input' ? node.inputs : node.outputs;
  const index = ports.findIndex((p) => p.name === port);
  if (index < 0) return undefined;
  return portPosition(position, sizeOf(node).width, side, index);
}

/** The curve of a wire, from an output to an input. */
export function wirePath(from: Point, to: Point): string {
  const bend = Math.max(40, Math.abs(to.x - from.x) / 2);
  return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
}

/** The rectangle around the nodes of a group, its title above. */
export function groupBounds(
  view: GraphView,
  group: GraphGroup,
  moved?: ReadonlyMap<string, Point>,
): { x: number; y: number; width: number; height: number } | undefined {
  const pad = 16;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of group.nodes) {
    const node = view.nodes.find((n) => n.id === id);
    if (!node) continue;
    const p = positionOf(view, id, moved);
    const size = sizeOf(node);
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + size.width);
    maxY = Math.max(maxY, p.y + size.height);
  }
  if (minX === Infinity) return undefined;
  return {
    x: minX - pad,
    y: minY - pad - 24,
    width: maxX - minX + 2 * pad,
    height: maxY - minY + 2 * pad + 24,
  };
}

/** The bounds of nodes, for framing them. */
export function boundsOf(
  view: GraphView,
  ids: readonly string[],
): { x: number; y: number; width: number; height: number } | undefined {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of ids) {
    const node = view.nodes.find((n) => n.id === id);
    const note = view.layout.notes?.find((n) => n.id === id);
    if (node) {
      const p = positionOf(view, id);
      const size = sizeOf(node);
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + size.width);
      maxY = Math.max(maxY, p.y + size.height);
    } else if (note) {
      minX = Math.min(minX, note.x);
      minY = Math.min(minY, note.y);
      maxX = Math.max(maxX, note.x + note.width);
      maxY = Math.max(maxY, note.y + note.height);
    }
  }
  return minX === Infinity
    ? undefined
    : { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// The colors of the types most used; the others from their name.
const typeColors: Record<string, string> = {
  exec: '#e5e5e5',
  number: '#8bd16a',
  f32: '#8bd16a',
  boolean: '#e05a5a',
  bool: '#e05a5a',
  string: '#e07ad4',
  entity: '#4aa3e6',
  vec3: '#e6c24a',
  pose: '#6ab0f3',
  any: '#a3a3a3',
};

/** The color of the wires and the ports of a type. */
export function typeColor(type: string): string {
  const known = typeColors[type];
  if (known) return known;
  if (/^vec[234]</.test(type)) return '#e6c24a';
  if (/^(texture|sampler)/.test(type)) return '#c38fff';
  let hash = 0;
  for (const char of type) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360} 55% 62%)`;
}

// The colors of the headers, by category.
const categoryColors: Record<string, string> = {
  event: '#8f2b2b',
  flow: '#4b4b4b',
  action: '#2b5a8f',
  pure: '#2f6b3b',
  value: '#2f6b3b',
  math: '#2f6b3b',
  input: '#2f6b3b',
  constant: '#3b5f2f',
  function: '#2b5a8f',
  macro: '#5b3b8f',
  output: '#8f5a2b',
  source: '#2b5a8f',
  blend: '#5b3b8f',
  state: '#8f5a2b',
};

/** The color of the header of a node, by its category. */
export function categoryColor(category: string | undefined): string {
  if (!category) return '#3f3f46';
  const known = categoryColors[category];
  if (known) return known;
  let hash = 0;
  for (const char of category) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360} 35% 32%)`;
}

/** Whether a port is the one given. */
export const isPort = (ref: PortRef, node: string, port: string): boolean =>
  ref.node === node && ref.port === port;

export { NodeGeometry };
