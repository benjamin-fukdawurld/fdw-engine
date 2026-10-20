import { describe, expect, it } from 'vitest';
import { formatDiagnostic, GraphError } from './Diagnostic';
import { parseDocument, serializeDocument } from './document';
import type { GraphDocument } from './GraphData';
import { Registry } from './Registry';
import { topologicalOrder } from './structure';
import { type NodeType, validateDocument } from './validate';

// A small kind of graph: numbers and texts, a sum with a port per term.
const value: NodeType = {
  id: 'value',
  params: { value: { kind: 'number', required: true } },
  inputs: () => [],
  outputs: () => [{ name: 'out', type: 'number' }],
};
const sum: NodeType = {
  id: 'sum',
  params: { terms: { kind: 'number', default: 2 } },
  inputs: (params) =>
    Array.from({ length: params['terms'] as number }, (_, i) => ({
      name: `t${i}`,
      type: 'number',
    })),
  outputs: () => [{ name: 'out', type: 'number' }],
};
const print: NodeType = {
  id: 'print',
  params: { style: { kind: 'string', values: ['plain', 'bold'] } },
  inputs: () => [
    { name: 'text', type: 'text', optional: true },
    { name: 'number', type: 'number', default: 0 },
  ],
  outputs: () => [],
};
const registry = new Registry<NodeType>([value, sum, print]);

const doc = (
  nodes: GraphDocument['nodes'],
  edges: GraphDocument['edges'] = [],
): GraphDocument => ({ format: 'test', version: 1, name: 'g', nodes, edges });
const edge = (from: string, fromPort: string, to: string, toPort: string) => ({
  from: { node: from, port: fromPort },
  to: { node: to, port: toPort },
});

describe('validateDocument', () => {
  it('orders a valid graph, its parameters resolved', () => {
    const result = validateDocument(
      doc(
        [
          { id: 'p', type: 'print', params: {} },
          { id: 's', type: 'sum', params: {} },
          { id: 'a', type: 'value', params: { value: 1 } },
          { id: 'b', type: 'value', params: { value: 2 } },
        ],
        [
          edge('a', 'out', 's', 't0'),
          edge('b', 'out', 's', 't1'),
          edge('s', 'out', 'p', 'number'),
        ],
      ),
      { registry },
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.order.indexOf('s')).toBeGreaterThan(
      result.order.indexOf('a'),
    );
    expect(result.order.at(-1)).toBe('p');
    expect(result.nodes.get('s')?.params['terms']).toBe(2);
    expect(result.incoming.get('s')).toHaveLength(2);
  });

  it('reports the problems of the nodes, the edges and the types', () => {
    const result = validateDocument(
      doc(
        [
          { id: 'a', type: 'value', params: {} },
          { id: 'a', type: 'value', params: { value: 1 } },
          { id: 'x', type: 'nope', params: {} },
          { id: 'p', type: 'print', params: { style: 'italic' } },
          { id: 'q', type: 'print', params: { colour: 1 } },
          { id: 's', type: 'sum', params: { terms: 1 } },
          { id: 'v', type: 'value', params: { value: 3 } },
        ],
        [
          edge('v', 'out', 'q', 'text'),
          edge('v', 'missing', 's', 't0'),
          edge('v', 'out', 'ghost', 't0'),
          edge('v', 'out', 's', 't9'),
        ],
      ),
      { registry },
    );
    const messages = result.diagnostics.map(formatDiagnostic);
    expect(result.valid).toBe(false);
    expect(messages).toEqual(
      expect.arrayContaining([
        'error: #a: missing required parameter "value"',
        'error: #a: duplicate node id "a"',
        'error: #x: unknown node type "nope"',
        'error: #p: parameter "style" must be one of "plain", "bold", got "italic"',
        'warning: #q: unknown parameter "colour" for node type "print"',
        'error: #q.text: expected text, got number from #v.out',
        'error: #v.missing: edge v.missing → s.t0: node type "value" has no output "missing"',
        'error: edge v.out → ghost.t0 references an unknown node',
        'error: #s.t9: edge v.out → s.t9: node type "sum" has no input "t9"',
        'error: #s.t0: input "t0" is not connected and has no default',
      ]),
    );
  });

  it('accepts the types its rules accept, and runs the checks of the kind', () => {
    const graph = doc(
      [
        { id: 'v', type: 'value', params: { value: 3 } },
        { id: 'p', type: 'print', params: {} },
      ],
      [edge('v', 'out', 'p', 'text')],
    );
    const result = validateDocument(graph, {
      registry,
      accepts: (from, to) => from === to || to === 'text',
      graph: (nodes, diagnostics) => {
        if (![...nodes.values()].some((n) => n.node.type === 'sum')) {
          diagnostics.push({ severity: 'error', message: 'no sum' });
        }
      },
    });
    expect(result.diagnostics.map(formatDiagnostic)).toEqual(['error: no sum']);
  });

  it('refuses two edges into an input, and cycles', () => {
    const result = validateDocument(
      doc(
        [
          { id: 's', type: 'sum', params: {} },
          { id: 't', type: 'sum', params: {} },
          { id: 'v', type: 'value', params: { value: 1 } },
        ],
        [
          edge('v', 'out', 's', 't0'),
          edge('v', 'out', 's', 't0'),
          edge('t', 'out', 's', 't1'),
          edge('s', 'out', 't', 't0'),
          edge('v', 'out', 't', 't1'),
        ],
      ),
      { registry },
    );
    expect(result.diagnostics.map(formatDiagnostic)).toEqual([
      'error: #s.t0: an input can only receive one edge',
      'error: the graph has a cycle involving nodes #s, #t',
    ]);
    expect(result.order).toEqual([]);
  });

  it('counts the edges of each port, and lets the control flow loop', () => {
    // A step of a program: reached from many steps, going on to one.
    const step: NodeType = {
      id: 'step',
      inputs: () => [
        { name: 'in', type: 'flow', connections: 'many', optional: true },
        { name: 'n', type: 'number', default: 0 },
      ],
      outputs: () => [
        { name: 'next', type: 'flow', connections: 'one' },
        { name: 'out', type: 'number' },
      ],
    };
    const rules = {
      registry: new Registry<NodeType>([step]),
      flow: (type: string) => type === 'flow',
    };
    const nodes = [
      { id: 'a', type: 'step', params: {} },
      { id: 'b', type: 'step', params: {} },
      { id: 'c', type: 'step', params: {} },
    ];
    // a → b → a, and a feeds b with a value: a loop of the flow, no cycle
    // of values.
    const loop = validateDocument(
      doc(nodes, [
        edge('a', 'next', 'b', 'in'),
        edge('b', 'next', 'a', 'in'),
        edge('c', 'next', 'a', 'in'),
        edge('a', 'out', 'b', 'n'),
      ]),
      rules,
    );
    expect(loop.diagnostics).toEqual([]);
    expect(loop.order.indexOf('a')).toBeLessThan(loop.order.indexOf('b'));

    const twice = validateDocument(
      doc(nodes, [edge('a', 'next', 'b', 'in'), edge('a', 'next', 'c', 'in')]),
      rules,
    );
    expect(twice.diagnostics.map(formatDiagnostic)).toEqual([
      'error: #a.next: edge a.next → c.in: output "next" can only feed one edge',
    ]);
    // Without `flow`, the loop is a cycle.
    const strict = validateDocument(
      doc(nodes, [edge('a', 'next', 'b', 'in'), edge('b', 'next', 'a', 'in')]),
      { registry: rules.registry },
    );
    expect(strict.valid).toBe(false);
  });
});

describe('topologicalOrder', () => {
  it('keeps the nodes without edges', () => {
    expect(topologicalOrder(['a', 'b'], [], [])).toEqual(['a', 'b']);
  });
});

describe('documents', () => {
  const format = { format: 'test', version: 1, kind: 'animation graph' };

  it('round-trips through JSON', () => {
    const graph = doc(
      [{ id: 'a', type: 'value', params: { value: 1 }, label: 'one' }],
      [],
    );
    expect(parseDocument(serializeDocument(graph), format)).toEqual(graph);
  });

  it('migrates the documents of older versions', () => {
    const v3 = {
      ...format,
      version: 3,
      migrations: {
        1: (d: Record<string, unknown>) => ({ ...d, name: `${d['title']}` }),
        2: (d: Record<string, unknown>) => ({
          ...d,
          nodes: (d['nodes'] as { id: string }[]).map((n) => ({
            ...n,
            type: 'value',
            params: {},
          })),
        }),
      },
    };
    const old = {
      format: 'test',
      version: 1,
      title: 'g',
      nodes: [{ id: 'a' }],
      edges: [],
    };
    expect(parseDocument(old, v3)).toEqual({
      ...old,
      version: 3,
      name: 'g',
      nodes: [{ id: 'a', type: 'value', params: {} }],
    });
    expect(() => parseDocument(old, { ...v3, migrations: {} })).toThrow(
      'No migration of animation graph from version 1',
    );
  });

  it('refuses malformed documents', () => {
    expect(() => parseDocument('[]', format)).toThrow(
      'An animation graph must be a JSON object',
    );
    expect(() => parseDocument({ format: 'other' }, format)).toThrow(
      'Unsupported document format "other", expected "test"',
    );
    expect(() => parseDocument({ format: 'test', version: 2 }, format)).toThrow(
      'Unsupported animation graph version 2, expected 1',
    );
    expect(() =>
      parseDocument(
        { format: 'test', version: 1, name: 'g', nodes: [{ id: 1 }] },
        format,
      ),
    ).toThrow('Malformed node at index 0');
    expect(() =>
      parseDocument(
        {
          format: 'test',
          version: 1,
          name: 'g',
          nodes: [],
          edges: [{ from: { node: 'a', port: 'b' }, to: {}, extra: 1 }],
        },
        format,
      ),
    ).toThrow('Malformed edge at index 0');
    expect(() =>
      parseDocument(
        { format: 'test', version: 1, name: 'g', nodes: [], edges: [] },
        {
          ...format,
          document: (data) => {
            if (!('states' in data)) throw new Error('no states');
          },
        },
      ),
    ).toThrow('no states');
  });
});

describe('Registry', () => {
  it('refuses two node types with the same id', () => {
    expect(() => new Registry<NodeType>([value, value])).toThrow(
      'Node type "value" is already registered',
    );
    expect(() => registry.require('nope')).toThrow('Unknown node type "nope"');
    expect([...registry.definitions].map((d) => d.id)).toEqual([
      'value',
      'sum',
      'print',
    ]);
  });

  it('lists the errors in a GraphError', () => {
    const error = new GraphError([
      { severity: 'error', node: 'a', port: 'b', message: 'wrong' },
      { severity: 'error', message: 'also' },
    ]);
    expect(error.message).toBe('error: #a.b: wrong\nerror: also');
  });
});
