import { describe, expect, it } from 'vitest';
import { GraphError } from '../graph/Diagnostic';
import { GraphBuilder } from '../graph/GraphBuilder';
import { std, stdMacros } from '../std';
import { BuiltinTypes } from '../types/ShaderType';
import { compile } from './compile';

const errors = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as GraphError).diagnostics.map((d) => d.message);
  }
  return [];
};

// A vertex generated from its index: the position, normal and uv of the
// surface computed in the vertex stage, without attribute.
const generated = () => {
  const g = new GraphBuilder('generated');
  const index = g.call(
    std.convert,
    { value: g.builtin('vertex-index') },
    {
      params: { to: BuiltinTypes.f32 },
    },
  );
  g.vertexAttribute('position', g.call(std.vec3, { x: index, y: 0, z: 0 }));
  g.vertexAttribute('normal', [0, 1, 0]);
  g.vertexAttribute('uv', g.call(std.vec2, { x: index, y: 1 }));
  return g;
};

describe('attributes computed by the graph', () => {
  it('replaces the attributes of the surface, of the graph and of the macros', () => {
    const g = generated();
    g.surface({
      shadingModel: 'phong',
      baseColor: g.attribute('uv', BuiltinTypes.vec2f).swizzle('xyx'),
      normal: g.call(stdMacros.bumpMapping, { height: 0.5, scale: 0.1 }),
    });
    const program = compile(g.build(), {
      vertexAttributes: [],
      capabilities: { objectTable: true },
    });
    expect(program.vertexInputs).toEqual([]);
  });

  it('counts as present for the optional attributes', () => {
    const g = generated();
    g.surface({
      baseColor: g.call(
        stdMacros.optionalAttribute,
        {
          fallback: [1, 0, 0],
        },
        { params: { semantic: 'normal', type: BuiltinTypes.vec3f } },
      ),
    });
    const program = compile(g.build(), { vertexAttributes: [] });
    expect(program.variantKey['hasAttribute.normal']).toBe(true);
    expect(program.vertexInputs).toEqual([]);
  });

  it('leaves the other attributes to the mesh', () => {
    const g = new GraphBuilder('offset');
    g.vertexAttribute('normal', [0, 0, 1]);
    g.surface({ baseColor: [1, 1, 1] });
    const program = compile(g.build(), { vertexAttributes: ['position'] });
    expect(program.vertexInputs.map((input) => input.semantic)).toEqual([
      'position',
    ]);
  });

  it('works with the raw stages', () => {
    const g = new GraphBuilder('raw');
    const position = g.attribute('position', BuiltinTypes.vec3f);
    g.vertexAttribute('position', [0, 0, 0]);
    g.node('output.vertex', {
      inputs: { clipPosition: g.call(std.extend, { xyz: position, w: 1 }) },
    });
    g.node('output.fragment', { inputs: { color: [1, 1, 1, 1] } });
    expect(compile(g.build()).vertexInputs).toEqual([]);
  });

  it('refuses an attribute computed twice, or from itself', () => {
    const twice = new GraphBuilder('twice');
    twice.vertexAttribute('uv', [0, 0]);
    twice.vertexAttribute('uv', [1, 1]);
    twice.surface({ baseColor: [1, 1, 1] });
    expect(errors(() => compile(twice.build()))).toEqual([
      'the attribute "uv" is computed twice',
    ]);

    const itself = new GraphBuilder('itself');
    itself.vertexAttribute(
      'position',
      itself.call(std.mul, {
        a: itself.attribute('position', BuiltinTypes.vec3f),
        b: 2,
      }),
    );
    itself.surface({ baseColor: [1, 1, 1] });
    expect(errors(() => compile(itself.build()))).toEqual([
      'the attribute "position" computed by the graph reads itself',
    ]);
  });

  it('deforms the attribute of the mesh, read with meshAttribute', () => {
    const g = new GraphBuilder('deformed');
    g.vertexAttribute(
      'position',
      g.call(std.mul, {
        a: g.meshAttribute('position', BuiltinTypes.vec3f),
        b: 2,
      }),
    );
    g.surface({
      baseColor: g.attribute('position', BuiltinTypes.vec3f),
    });
    const program = compile(g.build(), { vertexAttributes: ['position'] });
    // One input: the position of the mesh, doubled for the surface.
    expect(program.vertexInputs.map((input) => input.semantic)).toEqual([
      'position',
    ]);
    // Not the position of the mesh as is.
    const plain = new GraphBuilder('deformed');
    plain.surface({
      baseColor: plain.attribute('position', BuiltinTypes.vec3f),
    });
    expect(program.programKey).not.toBe(
      compile(plain.build(), { vertexAttributes: ['position'] }).programKey,
    );
  });

  it('goes on from a graph, its outputs and ids kept', () => {
    const g = new GraphBuilder('base');
    g.surface({ baseColor: g.uniform('tint', BuiltinTypes.vec3f) });
    g.parameter('wet', false);
    const base = g.build();
    const extended = GraphBuilder.extend(base, { name: 'extended' });
    extended.vertexAttribute('normal', [0, 0, 1]);
    // The surface is still there: a second one is refused.
    expect(() => extended.surface({ baseColor: [1, 1, 1] })).toThrow(
      /already has an output/,
    );
    const graph = extended.build();
    expect(graph.name).toBe('extended');
    expect(graph.parameters).toEqual(base.parameters);
    expect(new Set(graph.nodes.map((node) => node.id)).size).toBe(
      graph.nodes.length,
    );
    expect(base.nodes.length).toBe(graph.nodes.length - 1);
    expect(compile(graph, { vertexAttributes: ['position'] })).toBeDefined();
  });

  it('belongs to graphs with stages', () => {
    const g = new GraphBuilder('fullscreen');
    g.vertexAttribute('uv', [0, 0]);
    g.fullscreen({ color: [1, 1, 1, 1] });
    expect(() => g.build()).toThrow(/output.attribute nodes belong/);
  });
});
