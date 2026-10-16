import { describe, expect, it } from 'vitest';
import { GraphError } from '../graph/Diagnostic';
import { GraphBuilder } from '../graph/GraphBuilder';
import { NodeRegistry } from '../graph/NodeRegistry';
import { parseGraph, serializeGraph } from '../graph/serialization';
import {
  createStandardRegistry,
  defineShadingModel,
  standardNodeDefinitions,
  std,
  stdLights,
} from '../std';
import { BuiltinTypes } from '../types/ShaderType';
import { compile } from './compile';

// Toon shading: the base color, darkened where the summed diffuse light is
// below a threshold.
const toonGraph = (registry: NodeRegistry) => {
  const f = new GraphBuilder('toon', registry);
  const baseColor = f.functionInput('baseColor', BuiltinTypes.vec3f, {
    default: [1, 1, 1],
  });
  const threshold = f.functionInput('threshold', BuiltinTypes.f32, {
    default: 0.5,
  });
  const normal = f.functionInput('normal', BuiltinTypes.vec3f);
  f.functionInput('worldPosition', BuiltinTypes.vec4f);
  const light = f.node(stdLights.current);
  const received = f.call(stdLights.sum, {
    value: f.call(std.max, {
      a: f.call(std.dot, {
        a: f.call(std.normalize, { x: normal }),
        b: light.position.swizzle('xyz'),
      }),
      b: 0,
    }),
  });
  const shade = f.call(std.step, { edge: threshold, x: received });
  f.functionOutput(
    'color',
    f.call(std.extend, {
      xyz: f.call(std.mul, {
        a: baseColor,
        b: f.call(std.mix, { a: 0.4, b: 1, t: shade }),
      }),
      w: 1,
    }),
  );
  return f.build();
};

describe('shading models', () => {
  it('checks the contract of a shading model', () => {
    const noPosition = new GraphBuilder('bad');
    noPosition.functionOutput(
      'color',
      noPosition.uniform('color', BuiltinTypes.vec4f),
    );
    expect(() => defineShadingModel('bad', noPosition.build())).toThrow(
      /needs a worldPosition input/,
    );

    const wrongOutput = new GraphBuilder('bad');
    wrongOutput.functionInput('worldPosition', BuiltinTypes.vec4f);
    wrongOutput.functionOutput('rgb', [1, 0, 0]);
    expect(() => defineShadingModel('bad', wrongOutput.build())).toThrow(
      GraphError,
    );
  });

  it('gives its inputs to the surface', () => {
    const registry = createStandardRegistry();
    registry.register(defineShadingModel('toon', toonGraph(registry)));
    const g = new GraphBuilder('cartoon', registry);
    g.surface({ shadingModel: 'toon', baseColor: [1, 0.5, 0], threshold: 0.3 });
    expect(() => g.surface({ shadingModel: 'toon', shininess: 4 })).toThrow(
      /has no input "shininess"/,
    );

    const program = compile(g.build(), { registry });
    expect(program.vertexInputs.map((input) => input.semantic)).toEqual([
      'position',
      'normal',
    ]);
  });

  it('embeds custom shading models, not the standard ones', () => {
    const registry = createStandardRegistry();
    registry.register(defineShadingModel('toon', toonGraph(registry)));
    const g = new GraphBuilder('cartoon', registry);
    g.surface({ shadingModel: 'toon' });
    const graph = g.build();
    expect(graph.functions?.map((entry) => entry.id)).toEqual([
      'lighting.toon',
    ]);
    // Compiles with the standard registry alone.
    expect(compile(parseGraph(serializeGraph(graph))).programKey).toBe(
      compile(graph, { registry }).programKey,
    );

    const standard = new GraphBuilder('phong');
    standard.surface({ shadingModel: 'phong' });
    expect(standard.build().functions).toBeUndefined();
  });

  it('can replace a standard shading model', () => {
    const registry = new NodeRegistry(
      standardNodeDefinitions().filter(
        (definition) => definition.id !== 'lighting.phong',
      ),
    );
    registry.register(defineShadingModel('phong', toonGraph(registry)));
    const g = new GraphBuilder('replaced', registry);
    g.surface({ shadingModel: 'phong', threshold: 0.2 });
    expect(() => compile(g.build(), { registry })).not.toThrow();
  });

  it('only reads the mesh normal when the model has a normal input', () => {
    const unlit = new GraphBuilder('unlit');
    unlit.surface({ baseColor: [1, 0, 0] });
    expect(
      compile(unlit.build()).vertexInputs.map((input) => input.semantic),
    ).toEqual(['position']);

    const custom = new GraphBuilder('custom-normal');
    custom.surface({
      shadingModel: 'phong',
      normal: custom.uniform('up', BuiltinTypes.vec3f),
    });
    expect(
      compile(custom.build()).vertexInputs.map((input) => input.semantic),
    ).toEqual(['position']);
  });
});
