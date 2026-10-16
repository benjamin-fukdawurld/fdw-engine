import { describe, expect, it } from 'vitest';
import { createStandardRegistry, std } from '../std';
import { BuiltinTypes } from '../types/ShaderType';
import { GraphBuilder } from './GraphBuilder';
import { parseGraph, serializeGraph } from './serialization';
import { validateGraph } from './validateGraph';

const sampleGraph = () => {
  const g = new GraphBuilder('sample');
  const color = g.uniform('color', BuiltinTypes.vec4f, {
    default: [1, 0, 0, 1],
  });
  g.surface({ baseColor: g.call(std.saturate, { x: color }).swizzle('rgb') });
  return g.build();
};

describe('serialization', () => {
  it('round-trips a graph through JSON', () => {
    const graph = sampleGraph();
    const parsed = parseGraph(serializeGraph(graph));
    expect(parsed).toEqual(graph);
    expect(validateGraph(parsed, createStandardRegistry()).valid).toBe(true);
  });

  it('accepts an already parsed object', () => {
    const graph = sampleGraph();
    expect(parseGraph(JSON.parse(serializeGraph(graph)))).toEqual(graph);
  });

  it.each([
    ['a non-object', [], /must be a JSON object/],
    [
      'an unknown format',
      { format: 'other' },
      /Unsupported document format "other"/,
    ],
    [
      'an unknown version',
      { format: 'fdw-material-graph', version: 2 },
      /Unsupported material graph version 2/,
    ],
    [
      'a missing name',
      { format: 'fdw-material-graph', version: 1 },
      /must have a name/,
    ],
  ])('rejects %s', (_, data, message) => {
    expect(() => parseGraph(data)).toThrow(message);
  });

  it('rejects malformed nodes and edges', () => {
    const base = { format: 'fdw-material-graph', version: 1, name: 'x' };
    expect(() =>
      parseGraph({ ...base, nodes: [{ id: 'a' }], edges: [] }),
    ).toThrow('Malformed node at index 0');
    expect(() =>
      parseGraph({
        ...base,
        nodes: [],
        edges: [{ from: { node: 'a' }, to: { node: 'b', port: 'x' } }],
      }),
    ).toThrow('Malformed edge at index 0');
  });
});
