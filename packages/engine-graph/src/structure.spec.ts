import { describe, expect, it } from 'vitest';
import type { Diagnostic } from './Diagnostic';
import type { GraphEdge } from './GraphData';
import { topologicalOrder } from './structure';

const edge = (from: string, to: string): GraphEdge => ({
  from: { node: from, port: 'out' },
  to: { node: to, port: 'in' },
});

const sort = (ids: string[], edges: GraphEdge[]) => {
  const diagnostics: Diagnostic[] = [];
  const order = topologicalOrder(ids, edges, diagnostics);
  return { order, messages: diagnostics.map((d) => d.message) };
};

describe('topologicalOrder', () => {
  it('places each node after the nodes feeding it', () => {
    const { order, messages } = sort(
      ['d', 'c', 'b', 'a'],
      [edge('a', 'b'), edge('b', 'c'), edge('a', 'c'), edge('c', 'd')],
    );
    expect(messages).toEqual([]);
    expect(order).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps the order of the ids between independent nodes', () => {
    expect(sort(['x', 'y', 'z'], []).order).toEqual(['x', 'y', 'z']);
  });

  it('sorts long chains', () => {
    const ids = Array.from({ length: 100_000 }, (_, i) => `n${i}`);
    const edges = ids.slice(1).map((id, i) => edge(ids[i], id));
    const { order } = sort([...ids].reverse(), edges);
    expect(order).toEqual(ids);
  });

  it('lists only the nodes on a cycle', () => {
    // u → a ⇄ b → c → d, and e → e: u is placed, c and d are only
    // downstream of the cycle.
    const { order, messages } = sort(
      ['u', 'a', 'b', 'c', 'd', 'e'],
      [
        edge('u', 'a'),
        edge('a', 'b'),
        edge('b', 'a'),
        edge('b', 'c'),
        edge('c', 'd'),
        edge('e', 'e'),
      ],
    );
    expect(order).toBeUndefined();
    expect(messages).toEqual([
      'the graph has a cycle involving nodes #a, #b, #e',
    ]);
  });

  it('does not list the nodes between two cycles', () => {
    const { messages } = sort(
      ['a', 'b', 'm', 'c', 'd'],
      [
        edge('a', 'b'),
        edge('b', 'a'),
        edge('b', 'm'),
        edge('m', 'c'),
        edge('c', 'd'),
        edge('d', 'c'),
      ],
    );
    expect(messages).toEqual([
      'the graph has a cycle involving nodes #a, #b, #c, #d',
    ]);
  });
});
