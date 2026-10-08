import { describe, expect, it } from 'vitest';
import { GraphError } from '../graph/Diagnostic';
import { defineFunction } from '../graph/functions';
import { GraphBuilder } from '../graph/GraphBuilder';
import type { MaterialGraphData } from '../graph/MaterialGraphData';
import { parseGraph, serializeGraph } from '../graph/serialization';
import type { FunctionDefinition } from '../graph/NodeDefinition';
import { createStandardRegistry, std, stdLights } from '../std';
import { BuiltinTypes } from '../types/ShaderType';
import { compile } from './compile';
import { forEachInstruction, IrEntryPoint, IrInstruction } from './ir';

// scale(value: vec3, factor: f32 = 2) -> value × factor
const scaleFunction = () => {
  const f = new GraphBuilder('scale');
  const value = f.functionInput('value', BuiltinTypes.vec3f);
  const factor = f.functionInput('factor', BuiltinTypes.f32, { default: 2 });
  f.functionOutput('result', f.call(std.mul, { a: value, b: factor }));
  return defineFunction(f.build(), { id: 'test.scale' });
};

const fragmentOf = (graph: MaterialGraphData) =>
  compile(graph).module.entryPoints.find(
    (entryPoint) => entryPoint.stage === 'fragment'
  ) as IrEntryPoint;

const instructions = (entryPoint: IrEntryPoint) => {
  const all: IrInstruction[] = [];
  forEachInstruction(entryPoint.body, (instruction) => all.push(instruction));
  return all;
};

describe('defineFunction', () => {
  it('makes a node type from the ports of the graph', () => {
    const scale = scaleFunction();
    expect(scale.implementation.kind).toBe('graph');
    expect(scale.inputs({})).toEqual([
      { name: 'value', type: BuiltinTypes.vec3f },
      { name: 'factor', type: BuiltinTypes.f32, default: 2 },
    ]);
    // The type of an output is the type of its value.
    expect(scale.outputs({})).toEqual([
      { name: 'result', type: BuiltinTypes.vec3f },
    ]);
  });

  it('rejects graphs without outputs, or mixing stage outputs', () => {
    const f = new GraphBuilder('empty');
    f.functionInput('x', BuiltinTypes.f32);
    expect(() => defineFunction(f.build(), { id: 'test.empty' })).toThrow(
      GraphError
    );

    const g = new GraphBuilder('mixed');
    g.functionOutput('x', 1);
    expect(() => g.surface({ baseColor: [1, 0, 0] })).toThrow(/stage outputs/);
  });

  it('rejects duplicate port names', () => {
    const f = new GraphBuilder('duplicates');
    const a = f.functionInput('x', BuiltinTypes.f32);
    f.functionInput('x', BuiltinTypes.f32);
    f.functionOutput('result', a);
    expect(() => f.build()).toThrow(/duplicate function.input "x"/);
  });
});

describe('inlining', () => {
  it('compiles a call like the same graph written inline', () => {
    const scale = scaleFunction();
    const g = new GraphBuilder('called');
    g.surface({
      baseColor: g.call(scale, {
        value: g.uniform('color', BuiltinTypes.vec3f),
        factor: 0.5,
      }),
    });

    const h = new GraphBuilder('called');
    h.surface({
      baseColor: h.call(std.mul, {
        a: h.uniform('color', BuiltinTypes.vec3f),
        b: 0.5,
      }),
    });
    expect(compile(g.build()).programKey).toBe(compile(h.build()).programKey);
  });

  it('uses the default of the unconnected inputs', () => {
    const scale = scaleFunction();
    const g = new GraphBuilder('default');
    g.surface({
      baseColor: g.call(scale, {
        value: g.uniform('color', BuiltinTypes.vec3f),
      }),
    });
    const constants = instructions(fragmentOf(g.build()))
      .filter((i) => i.op.kind === 'constant')
      .map((i) => (i.op as { value: unknown }).value);
    expect(constants).toContainEqual([2, 2, 2]);
  });

  it('composes the swizzles of the call and of the function', () => {
    const f = new GraphBuilder('swap');
    const v = f.functionInput('v', BuiltinTypes.vec3f);
    f.functionOutput('result', v.swizzle('zyx'));
    const swap = defineFunction(f.build(), { id: 'test.swap' });

    const g = new GraphBuilder('swizzled');
    const color = g.uniform('color', BuiltinTypes.vec4f);
    g.surface({ baseColor: g.call(swap, { v: color.swizzle('xyz') }) });
    const swizzles = instructions(fragmentOf(g.build()))
      .filter((i) => i.op.kind === 'swizzle')
      .map((i) => (i.op as { components: string }).components);
    // color.xyz.zyx, folded into a single swizzle.
    expect(swizzles).toContain('zyx');
  });

  it('inlines functions calling functions', () => {
    const scale = scaleFunction();
    const f = new GraphBuilder('twice');
    const v = f.functionInput('v', BuiltinTypes.vec3f);
    f.functionOutput(
      'result',
      f.call(scale, { value: f.call(scale, { value: v }) })
    );
    const twice = defineFunction(f.build(), {
      id: 'test.twice',
      registry: f.registry,
    });

    const g = new GraphBuilder('nested');
    g.surface({
      baseColor: g.call(twice, { v: g.uniform('color', BuiltinTypes.vec3f) }),
    });
    const products = instructions(fragmentOf(g.build())).filter(
      (i) => i.op.kind === 'binary'
    );
    expect(products).toHaveLength(2);
  });

  it('rejects recursive functions', () => {
    // Only possible with a hand-made graph: a function graph calling the id
    // of its own function.
    const body: MaterialGraphData = {
      format: 'fdw-material-graph',
      version: 1,
      name: 'loop',
      nodes: [
        {
          id: 'in',
          type: 'function.input',
          params: { name: 'v', type: BuiltinTypes.f32 },
        },
        { id: 'call', type: 'test.loop', params: {} },
        { id: 'out', type: 'function.output', params: { name: 'result' } },
      ],
      edges: [
        {
          from: { node: 'in', port: 'value' },
          to: { node: 'call', port: 'v' },
        },
        {
          from: { node: 'call', port: 'result' },
          to: { node: 'out', port: 'value' },
        },
      ],
    };
    const loop: FunctionDefinition = {
      id: 'test.loop',
      category: 'function',
      implementation: { kind: 'graph', graph: body },
      inputs: () => [{ name: 'v', type: BuiltinTypes.f32 }],
      outputs: () => [{ name: 'result', type: BuiltinTypes.f32 }],
    };
    const registry = createStandardRegistry().register(loop);
    const g = new GraphBuilder('recursive', registry);
    g.surface({
      baseColor: g.call(std.vec3, { x: g.call(loop, { v: 1 }), y: 0, z: 0 }),
    });
    expect(() => compile(g.build(), { registry })).toThrow(
      /recursive function: test.loop → test.loop/
    );
  });

  it('keeps the resources, light loops and labels of the function', () => {
    const f = new GraphBuilder('lit-texture');
    const uv = f.functionInput('uv', BuiltinTypes.vec2f);
    const texel = f.call(std.textureSample, {
      texture: f.texture('map'),
      sampler: f.sampler('mapSampler'),
      uv,
    });
    const light = f.node(stdLights.current);
    f.functionOutput(
      'result',
      f.call(
        stdLights.sum,
        {
          value: f.call(std.mul, { a: light.diffuse, b: texel.swizzle('rgb') }),
        },
        { label: 'received' }
      )
    );
    const litTexture = defineFunction(f.build(), {
      id: 'test.litTexture',
      registry: f.registry,
    });

    const g = new GraphBuilder('caller');
    g.surface({
      baseColor: g.call(litTexture, {
        uv: g.attribute('uv', BuiltinTypes.vec2f),
      }),
    });
    const program = compile(g.build());
    const bindings = program.layout.groups.flatMap((group) =>
      group.bindings.map((binding) => binding.name)
    );
    expect(bindings).toEqual(expect.arrayContaining(['map', 'mapSampler']));
    const fragment = fragmentOf(g.build());
    const loop = fragment.body.find((i) => i.op.kind === 'loop-sum');
    expect(loop?.name).toBe('received');
  });
});

describe('embedded functions', () => {
  it('embeds the called functions, so that the JSON compiles alone', () => {
    const scale = scaleFunction();
    const g = new GraphBuilder('embedded');
    g.surface({
      baseColor: g.call(scale, {
        value: g.uniform('color', BuiltinTypes.vec3f),
      }),
    });
    const graph = g.build();
    expect(graph.functions?.map((entry) => entry.id)).toEqual(['test.scale']);

    const parsed = parseGraph(serializeGraph(graph));
    expect(compile(parsed).programKey).toBe(compile(graph).programKey);
  });

  it('rejects malformed functions in JSON', () => {
    const g = new GraphBuilder('x');
    g.surface({ baseColor: [1, 0, 0] });
    const graph = { ...g.build(), functions: [{ id: 1 }] };
    expect(() => parseGraph(JSON.stringify(graph))).toThrow(
      /Malformed function/
    );
  });
});
