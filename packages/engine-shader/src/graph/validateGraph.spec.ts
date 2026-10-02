import { describe, expect, it } from 'vitest';
import { createStandardRegistry } from '../std';
import { T } from '../types/ShaderType';
import type {
  GraphEdge,
  GraphNode,
  MaterialGraphData,
} from './MaterialGraphData';
import { validateGraph } from './validateGraph';

const registry = createStandardRegistry();

const graph = (
  nodes: GraphNode[],
  edges: GraphEdge[] = []
): MaterialGraphData => ({
  format: 'fdw-material-graph',
  version: 1,
  name: 'test',
  nodes,
  edges,
});

const edge = (
  from: string,
  fromPort: string,
  to: string,
  toPort: string,
  swizzle?: string
): GraphEdge => ({
  from: { node: from, port: fromPort },
  to: { node: to, port: toPort },
  ...(swizzle ? { swizzle } : {}),
});

const surface: GraphNode = { id: 'out', type: 'output.surface', params: {} };

const errorsOf = (data: MaterialGraphData) =>
  validateGraph(data, registry)
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => d.message);

describe('validateGraph', () => {
  it('accepts a valid graph and returns order and types', () => {
    const result = validateGraph(
      graph(
        [
          {
            id: 'color',
            type: 'input.attribute',
            params: { semantic: 'color', type: T.vec4f },
          },
          surface,
        ],
        [edge('color', 'value', 'out', 'baseColor', 'rgb')]
      ),
      registry
    );
    expect(result.valid).toBe(true);
    expect(result.order).toEqual(['color', 'out']);
    expect(result.types.get('out')?.inputs['baseColor']).toEqual(T.vec3f);
  });

  it('reports duplicate ids and unknown node types', () => {
    expect(
      errorsOf(
        graph([
          surface,
          { ...surface },
          { id: 'x', type: 'std.unknown', params: {} },
        ])
      )
    ).toEqual(
      expect.arrayContaining([
        'duplicate node id "out"',
        'unknown node type "std.unknown"',
      ])
    );
  });

  it('checks the parameters', () => {
    expect(
      errorsOf(
        graph([
          surface,
          { id: 'u', type: 'input.uniform', params: { name: 'tint' } },
        ])
      )
    ).toContain('missing required parameter "type"');
    expect(
      errorsOf(
        graph([
          surface,
          {
            id: 't',
            type: 'input.texture',
            params: { name: 't', dimension: '4d' },
          },
        ])
      )
    ).toEqual([expect.stringMatching(/parameter "dimension" must be one of/)]);
  });

  it('warns about unknown parameters and defaults', () => {
    const result = validateGraph(
      graph([
        { ...surface, params: { color: 1 }, defaults: { colour: [1, 0, 0] } },
      ]),
      registry
    );
    expect(result.valid).toBe(true);
    expect(result.diagnostics.map((d) => d.severity)).toEqual([
      'warning',
      'warning',
    ]);
  });

  it('reports edges to unknown nodes or ports', () => {
    const errors = errorsOf(
      graph(
        [
          {
            id: 'a',
            type: 'const.value',
            params: { type: T.vec3f, value: [1, 1, 1] },
          },
          surface,
        ],
        [
          edge('a', 'nope', 'out', 'baseColor'),
          edge('a', 'value', 'out', 'nope'),
          edge('ghost', 'value', 'out', 'baseColor'),
        ]
      )
    );
    expect(errors).toEqual([
      expect.stringMatching(/has no output "nope"/),
      expect.stringMatching(/has no input "nope"/),
      expect.stringMatching(/references an unknown node/),
    ]);
  });

  it('allows only one edge per input', () => {
    const errors = errorsOf(
      graph(
        [
          {
            id: 'a',
            type: 'const.value',
            params: { type: T.vec3f, value: [1, 1, 1] },
          },
          surface,
        ],
        [
          edge('a', 'value', 'out', 'baseColor'),
          edge('a', 'value', 'out', 'baseColor'),
        ]
      )
    );
    expect(errors).toEqual(['an input can only receive one edge']);
  });

  it('detects cycles and names the nodes involved', () => {
    const errors = errorsOf(
      graph(
        [
          { id: 'a', type: 'std.add', params: {}, defaults: { b: 1 } },
          { id: 'b', type: 'std.add', params: {}, defaults: { b: 1 } },
          surface,
        ],
        [edge('a', 'result', 'b', 'a'), edge('b', 'result', 'a', 'a')]
      )
    );
    expect(errors).toEqual(['the graph has a cycle involving nodes #a, #b']);
  });

  it('requires exactly one output node', () => {
    expect(errorsOf(graph([]))).toEqual(['the graph has no output node']);
    expect(errorsOf(graph([surface, { ...surface, id: 'out2' }]))).toEqual([
      expect.stringMatching(/has 2 output nodes/),
    ]);
  });

  it('type-checks the edges, swizzles included', () => {
    const nodes: GraphNode[] = [
      {
        id: 'n',
        type: 'input.attribute',
        params: { semantic: 'normal', type: T.vec3f },
      },
      surface,
    ];
    expect(
      errorsOf(graph(nodes, [edge('n', 'value', 'out', 'alpha')]))
    ).toEqual(['expects f32, got vec3<f32>']);
    expect(
      errorsOf(graph(nodes, [edge('n', 'value', 'out', 'alpha', 'w')]))
    ).toEqual(['swizzle ".w" is out of range for a vec3']);
    expect(
      errorsOf(graph(nodes, [edge('n', 'value', 'out', 'alpha', 'xg')]))
    ).toEqual([expect.stringMatching(/invalid swizzle/)]);
  });

  it('does not cascade errors from an untyped node', () => {
    const errors = errorsOf(
      graph(
        [
          { id: 'bad', type: 'std.normalize', params: {}, defaults: { x: 1 } },
          { id: 'next', type: 'std.normalize', params: {} },
          surface,
        ],
        [edge('bad', 'result', 'next', 'x')]
      )
    );
    expect(errors).toHaveLength(1);
  });

  it('requires resources with the same name to be declared identically', () => {
    const base = {
      id: 'u1',
      type: 'input.uniform',
      params: { name: 'tint', type: T.vec4f, default: [1, 1, 1, 1] },
    };
    expect(
      errorsOf(
        graph([
          base,
          {
            ...base,
            id: 'u2',
            params: { ...base.params, default: [0, 0, 0, 1] },
          },
          surface,
        ])
      )
    ).toEqual([]);
    expect(
      errorsOf(
        graph([
          base,
          { ...base, id: 'u2', params: { name: 'tint', type: T.vec3f } },
          surface,
        ])
      )
    ).toEqual(['resource "tint" is declared differently by #u1']);
    expect(
      errorsOf(
        graph([
          {
            id: 'a1',
            type: 'input.attribute',
            params: { semantic: 'uv', type: T.vec2f },
          },
          {
            id: 'a2',
            type: 'input.attribute',
            params: { semantic: 'uv', type: T.vec3f },
          },
          surface,
        ])
      )
    ).toEqual(['attribute "uv" is declared with different types (see #a1)']);
  });
});
