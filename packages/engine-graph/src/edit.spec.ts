import { describe, expect, it } from 'vitest';
import { parseDocument } from './document';
import {
  addNode,
  addNote,
  connect,
  copyFragment,
  disconnect,
  editGroup,
  editNote,
  groupNodes,
  moveNodes,
  pasteFragment,
  removeDecorations,
  removeNodes,
  setDefault,
  setLabel,
  setParams,
  uniqueNodeId,
} from './edit';
import type { GraphEdge, GraphNode } from './GraphData';
import {
  autoLayout,
  type GraphBody,
  NodeGeometry,
  nodeSize,
  nodesBounds,
  type NodeShape,
  portPosition,
} from './layout';

const node = (id: string, type = 'value'): GraphNode => ({
  id,
  type,
  params: {},
});
const edge = (from: string, to: string, port = 'in'): GraphEdge => ({
  from: { node: from, port: 'out' },
  to: { node: to, port },
});

// a → b → d, a → c → d, d's second input from c.
const body: GraphBody = {
  nodes: ['a', 'b', 'c', 'd'].map((id) => node(id)),
  edges: [
    edge('a', 'b'),
    edge('a', 'c'),
    edge('b', 'd'),
    edge('c', 'd', 'in2'),
  ],
  layout: {
    nodes: {
      a: { x: 0, y: 0 },
      b: { x: 200, y: -50 },
      c: { x: 200, y: 50 },
      d: { x: 400, y: 0 },
    },
    groups: [{ id: 'g1', title: 'Middle', nodes: ['b', 'c'] }],
  },
};

describe('the geometry', () => {
  it('sizes a node by its title and its ports', () => {
    const small = nodeSize({
      title: 'add',
      inputs: ['a', 'b'],
      outputs: ['x'],
    });
    expect(small).toEqual({
      width: NodeGeometry.minWidth,
      height: NodeGeometry.header + 2 * NodeGeometry.row + NodeGeometry.padding,
    });
    const long = nodeSize({
      title: 'a very long title for a node of the graph',
      inputs: [],
      outputs: [],
    });
    expect(long.width).toBeGreaterThan(NodeGeometry.minWidth);
    expect(long.width).toBeLessThanOrEqual(NodeGeometry.maxWidth);
    expect(long.width % 10).toBe(0);
  });

  it('places the ports on the edges, a row each', () => {
    expect(portPosition({ x: 10, y: 20 }, 100, 'input', 0)).toEqual({
      x: 10,
      y: 20 + NodeGeometry.header + NodeGeometry.row / 2,
    });
    expect(portPosition({ x: 10, y: 20 }, 100, 'output', 2).x).toBe(110);
  });

  it('bounds nodes', () => {
    const sizes = new Map([
      ['a', { width: 100, height: 50 }],
      ['d', { width: 100, height: 80 }],
    ]);
    expect(
      nodesBounds(body.layout?.nodes ?? {}, sizes, ['a', 'd', 'nope']),
    ).toEqual({ x: 0, y: 0, width: 500, height: 80 });
    expect(nodesBounds({}, sizes, ['a'])).toBeUndefined();
  });
});

describe('autoLayout', () => {
  const shapes = new Map<string, NodeShape>(
    ['a', 'b', 'c', 'd', 'e'].map((id) => [
      id,
      { title: id, inputs: ['in', 'in2'], outputs: ['out'] },
    ]),
  );

  it('places the nodes in columns, from the sources', () => {
    const positions = autoLayout(body, shapes);
    expect(positions['a'].x).toBe(0);
    expect(positions['b'].x).toBe(positions['c'].x);
    expect(positions['b'].x).toBeGreaterThan(positions['a'].x);
    expect(positions['d'].x).toBeGreaterThan(positions['b'].x);
    expect(positions['b'].y).not.toBe(positions['c'].y);
  });

  it('puts a value just before the node that reads it, and survives loops', () => {
    const loop: GraphBody = {
      nodes: ['a', 'b', 'c', 'd', 'e'].map((id) => node(id)),
      // a → b → c → d, e only feeds d, d → b closes a loop.
      edges: [
        edge('a', 'b'),
        edge('b', 'c'),
        edge('c', 'd'),
        edge('e', 'd', 'in2'),
        edge('d', 'b', 'in2'),
      ],
    };
    const positions = autoLayout(loop, shapes, { origin: { x: 10, y: 5 } });
    expect(positions['a'].x).toBe(10);
    // e in the column of c.
    expect(positions['e'].x).toBe(positions['c'].x);
    expect(positions['d'].x).toBeGreaterThan(positions['c'].x);
  });
});

describe('the edits', () => {
  it('adds and removes nodes, with their edges, positions and groups', () => {
    const added = addNode(body, node('e'), { x: 600, y: 0 });
    expect(added.nodes).toHaveLength(5);
    expect(added.layout?.nodes?.['e']).toEqual({ x: 600, y: 0 });
    expect(() => addNode(body, node('a'))).toThrow(/exists already/);
    const removed = removeNodes(body, ['b', 'c']);
    expect(removed.nodes.map((n) => n.id)).toEqual(['a', 'd']);
    expect(removed.edges).toEqual([]);
    expect(removed.layout?.nodes?.['b']).toBeUndefined();
    // The group left empty goes.
    expect(removed.layout?.groups).toEqual([]);
    // The body given is left as it was.
    expect(body.nodes).toHaveLength(4);
  });

  it('connects, replacing the edge of an input that takes one', () => {
    const replaced = connect(body, edge('a', 'd'));
    expect(replaced.edges.filter((e) => e.to.node === 'd')).toEqual([
      edge('c', 'd', 'in2'),
      edge('a', 'd'),
    ]);
    const both = connect(body, edge('a', 'd'), { replaceInput: false });
    expect(both.edges).toHaveLength(5);
    // An output that feeds one edge (an exec output).
    const moved = connect(body, edge('a', 'd'), {
      replaceInput: false,
      replaceOutput: true,
    });
    expect(moved.edges.filter((e) => e.from.node === 'a')).toEqual([
      edge('a', 'd'),
    ]);
    // Twice the same edge: once.
    expect(connect(body, edge('a', 'b')).edges).toHaveLength(4);
  });

  it('disconnects edges, or a port', () => {
    expect(disconnect(body, [edge('a', 'b')]).edges).toHaveLength(3);
    expect(
      disconnect(body, { port: { node: 'a', port: 'out' } }).edges,
    ).toHaveLength(2);
  });

  it('sets parameters, defaults and labels', () => {
    let next = setParams(body, 'a', { value: 2, other: 'x' });
    next = setParams(next, 'a', { other: undefined });
    expect(next.nodes[0].params).toEqual({ value: 2 });
    next = setDefault(next, 'b', 'in', 3);
    expect(next.nodes[1].defaults).toEqual({ in: 3 });
    next = setDefault(next, 'b', 'in', undefined);
    expect(next.nodes[1]).not.toHaveProperty('defaults');
    next = setLabel(next, 'c', 'middle');
    expect(next.nodes[2].label).toBe('middle');
    expect(setLabel(next, 'c', '').nodes[2]).not.toHaveProperty('label');
    expect(() => setLabel(next, 'nope', 'x')).toThrow(/No node/);
  });

  it('moves nodes and notes, and edits notes and groups', () => {
    let next = addNote(body, {
      id: 'note1',
      x: 0,
      y: 200,
      width: 160,
      height: 60,
      text: 'Hello',
    });
    next = moveNodes(next, { a: { x: 5, y: 6 }, note1: { x: 7, y: 8 } });
    expect(next.layout?.nodes?.['a']).toEqual({ x: 5, y: 6 });
    expect(next.layout?.notes?.[0]).toMatchObject({ x: 7, y: 8 });
    next = editNote(next, 'note1', { text: 'Bye' });
    expect(next.layout?.notes?.[0].text).toBe('Bye');
    next = groupNodes(next, { id: 'g2', title: 'Ends', nodes: ['a', 'b'] });
    // b leaves g1.
    expect(next.layout?.groups).toEqual([
      { id: 'g1', title: 'Middle', nodes: ['c'] },
      { id: 'g2', title: 'Ends', nodes: ['a', 'b'] },
    ]);
    next = editGroup(next, 'g2', { title: 'Start', color: '#f80' });
    expect(next.layout?.groups?.[1]).toMatchObject({
      title: 'Start',
      color: '#f80',
    });
    next = removeDecorations(next, ['g1', 'note1']);
    expect(next.layout?.groups?.map((g) => g.id)).toEqual(['g2']);
    expect(next.layout?.notes).toEqual([]);
    expect(next.nodes).toHaveLength(4);
  });

  it('copies and pastes nodes with new ids, their edges following', () => {
    const fragment = copyFragment(body, ['b', 'd']);
    expect(fragment.nodes.map((n) => n.id)).toEqual(['b', 'd']);
    expect(fragment.edges).toEqual([edge('b', 'd')]);
    expect(fragment.positions).toEqual({
      b: { x: 0, y: 0 },
      d: { x: 200, y: 50 },
    });
    const { body: pasted, ids } = pasteFragment(body, fragment, {
      x: 1000,
      y: 1000,
    });
    expect(ids).toEqual(['n1', 'n2']);
    expect(pasted.edges.at(-1)).toEqual(edge('n1', 'n2'));
    expect(pasted.layout?.nodes?.['n2']).toEqual({ x: 1200, y: 1050 });
    expect(uniqueNodeId(pasted)).toBe('n3');
  });

  it('keeps the layout through the serialization, and checks it', () => {
    const format = { format: 'test', version: 1, kind: 'test graph' };
    const document = { format: 'test', version: 1, name: 'g', ...body };
    expect(parseDocument(JSON.stringify(document), format)).toEqual(document);
    expect(() =>
      parseDocument({ ...document, layout: { nodes: [] } }, format),
    ).toThrow(/Malformed "layout"/);
  });
});
