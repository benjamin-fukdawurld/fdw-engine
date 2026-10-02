import { describe, expect, it } from 'vitest';
import { GraphError } from '../graph/Diagnostic';
import { GraphBuilder } from '../graph/GraphBuilder';
import type { MaterialGraphData } from '../graph/MaterialGraphData';
import type { NodeDefinition } from '../graph/NodeDefinition';
import { createStandardRegistry, std, stdMacros } from '../std';
import { T } from '../types/ShaderType';
import { CompiledProgram, compile, CompileOptions } from './compile';
import type { IrEntryPoint, IrOp } from './ir';

const stage = (program: CompiledProgram, name: 'vertex' | 'fragment') =>
  program.module.entryPoints.find(
    (entryPoint) => entryPoint.stage === name
  ) as IrEntryPoint;
const ops = (entryPoint: IrEntryPoint, kind: IrOp['kind']) =>
  entryPoint.body.filter((instruction) => instruction.op.kind === kind);
const resources = (program: CompiledProgram) =>
  program.layout.groups.flatMap((group) =>
    group.bindings.map((binding) => binding.name)
  );

const errorOf = (graph: MaterialGraphData, options?: CompileOptions) => {
  try {
    compile(graph, options);
  } catch (error) {
    expect(error).toBeInstanceOf(GraphError);
    return (error as GraphError).message;
  }
  throw new Error('expected a GraphError');
};

describe('macro.staticSwitch', () => {
  const graph = () => {
    const g = new GraphBuilder('switch');
    g.parameter('useTexture', false);
    const textured = g.call(std.textureSample, {
      texture: g.texture('map'),
      sampler: g.sampler('mapSampler'),
      uv: g.attribute('uv', T.vec2f),
    });
    const chosen = g.call(
      stdMacros.staticSwitch,
      {
        ifTrue: textured.swizzle('rgb'),
        ifFalse: g.uniform('color', T.vec3f),
      },
      { params: { feature: 'useTexture' } }
    );
    g.surface({ baseColor: chosen });
    return g.build();
  };

  it('compiles only the chosen branch', () => {
    const plain = compile(graph());
    expect(resources(plain)).not.toContain('map');
    expect(plain.variantKey).toEqual({ useTexture: false });

    const textured = compile(graph(), { features: { useTexture: true } });
    expect(resources(textured)).toEqual(
      expect.arrayContaining(['map', 'mapSampler'])
    );
    expect(resources(textured)).not.toContain('materialUniforms');
    expect(textured.variantKey).toEqual({ useTexture: true });
    expect(textured.programKey).not.toBe(plain.programKey);
  });
});

describe('macro.optionalAttribute', () => {
  const withColor = ['position', 'color'];
  const withoutColor = ['position'];

  const vertexColored = () => {
    const g = new GraphBuilder('vertex-color');
    const color = g.call(
      stdMacros.optionalAttribute,
      { fallback: [1, 1, 1] },
      {
        params: { semantic: 'color', type: T.vec3f },
      }
    );
    g.surface({ baseColor: color });
    return g.build();
  };

  it('reads the attribute when the mesh has it, the fallback otherwise', () => {
    const colored = compile(vertexColored(), { vertexAttributes: withColor });
    expect(colored.vertexInputs.map((input) => input.semantic)).toEqual([
      'position',
      'color',
    ]);
    expect(colored.variantKey).toEqual({ 'hasAttribute.color': true });

    const plain = compile(vertexColored(), { vertexAttributes: withoutColor });
    expect(plain.vertexInputs.map((input) => input.semantic)).toEqual([
      'position',
    ]);
    expect(plain.variantKey).toEqual({ 'hasAttribute.color': false });
    expect(plain.programKey).not.toBe(colored.programKey);
  });

  it('does not create variants for attributes the graph does not read', () => {
    const g = new GraphBuilder('flat');
    g.surface({ baseColor: g.uniform('color', T.vec3f) });
    const graph = g.build();
    const colored = compile(graph, { vertexAttributes: withColor });
    const plain = compile(graph, { vertexAttributes: withoutColor });
    expect(colored.variantKey).toEqual({});
    expect(colored.programKey).toBe(plain.programKey);
  });
});

describe('macro.repeat', () => {
  // A function node with an index: value + index.
  const registry = () => {
    const r = createStandardRegistry();
    r.register({
      id: 'test.addIndex',
      category: 'function',
      implementation: { kind: 'intrinsic', op: 'add' },
      inputs: () => [
        { name: 'value', type: T.f32 },
        { name: 'index', type: T.f32 },
      ],
      outputs: () => [{ name: 'result', type: T.f32 }],
    } as NodeDefinition);
    return r;
  };

  const repeated = (count: number) => {
    const g = new GraphBuilder('repeat', registry());
    g.surface({
      alpha: g.call(
        stdMacros.repeat,
        { initial: g.uniform('start', T.f32) },
        { params: { body: 'test.addIndex', count } }
      ),
    });
    return g.build();
  };

  it('chains the body node count times, passing the index', () => {
    const program = compile(repeated(3), { registry: registry() });
    const fragment = stage(program, 'fragment');
    // start + 0 + 1 + 2
    expect(ops(fragment, 'binary')).toHaveLength(3);
    expect(
      ops(fragment, 'constant').map((i) => (i.op as { value: number }).value)
    ).toEqual(expect.arrayContaining([0, 1, 2]));
  });

  it('returns the initial value for a count of zero', () => {
    const program = compile(repeated(0), { registry: registry() });
    expect(ops(stage(program, 'fragment'), 'binary')).toHaveLength(0);
  });

  it('reports invalid counts', () => {
    expect(errorOf(repeated(-1), { registry: registry() })).toMatch(
      /macro.repeat: count must be a non-negative integer, got -1/
    );
  });

  it('reports function node types without implementation', () => {
    const r = registry();
    r.register({
      id: 'test.unimplemented',
      category: 'function',
      inputs: () => [{ name: 'value', type: T.f32 }],
      outputs: () => [{ name: 'result', type: T.f32 }],
    });
    const g = new GraphBuilder('unimplemented', r);
    g.surface({ alpha: g.call('test.unimplemented', { value: 1 }) });
    expect(errorOf(g.build(), { registry: r })).toMatch(
      /node type "test.unimplemented" has no implementation/
    );
  });
});

describe('macro.normalMapping', () => {
  const graph = () => {
    const g = new GraphBuilder('normal-mapped');
    const sample = g.call(std.textureSample, {
      texture: g.texture('normalMap'),
      sampler: g.sampler('normalSampler'),
      uv: g.attribute('uv', T.vec2f),
    });
    const normal = g.call(stdMacros.normalMapping, {
      sample: sample.swizzle('rgb'),
    });
    g.surface({ shadingModel: 'phong', normal });
    return g.build();
  };
  const base = ['position', 'normal', 'uv'];

  it('uses the tangents when the mesh has them', () => {
    const program = compile(graph(), {
      vertexAttributes: [...base, 'tangent'],
    });
    expect(program.vertexInputs.map((input) => input.semantic)).toContain(
      'tangent'
    );
    expect(program.variantKey).toEqual({ 'hasAttribute.tangent': true });
    expect(
      ops(stage(program, 'fragment'), 'intrinsic').map((i) => i.op)
    ).toContainEqual({
      kind: 'intrinsic',
      name: 'cross',
    });
  });

  it('falls back on the interpolated normal without tangents', () => {
    const program = compile(graph(), { vertexAttributes: base });
    expect(program.vertexInputs.map((input) => input.semantic)).not.toContain(
      'tangent'
    );
    expect(program.variantKey).toEqual({ 'hasAttribute.tangent': false });
    // The normal map is not sampled anymore.
    expect(resources(program)).not.toContain('normalMap');
  });
});

describe('lighting.phong', () => {
  const phong = () => {
    const g = new GraphBuilder('phong');
    g.surface({
      shadingModel: 'phong',
      baseColor: g.uniform('color', T.vec3f),
      shininess: g.uniform('shininess', T.f32),
    });
    return g.build();
  };

  it('compiles with the main light of the frame', () => {
    const program = compile(phong());
    const fragment = stage(program, 'fragment');
    const members = ops(fragment, 'load-resource').map(
      (i) => (i.op as { member?: string }).member
    );
    expect(members).toEqual(
      expect.arrayContaining([
        'lightPosition',
        'lightAmbient',
        'lightDiffuse',
        'lightSpecular',
        'lightAttenuation',
        'cameraPosition',
      ])
    );
    expect(program.vertexInputs.map((input) => input.semantic)).toEqual([
      'position',
      'normal',
    ]);
  });

  it('normalizes the normal per fragment, after interpolation', () => {
    const program = compile(phong());
    const vertex = stage(program, 'vertex');
    // The vertex stage only transforms the normal; normalize() and the
    // lighting are per fragment.
    expect(ops(vertex, 'intrinsic')).toEqual([]);
    // Interpolated: the world normal and the world position.
    expect(vertex.outputs.map((output) => output.type)).toEqual([
      T.vec4f,
      T.vec3f,
      T.vec4f,
    ]);
    expect(
      ops(stage(program, 'fragment'), 'intrinsic').map(
        (i) => (i.op as { name: string }).name
      )
    ).toEqual(
      expect.arrayContaining([
        'normalize',
        'dot',
        'reflect',
        'pow',
        'step',
        'length',
      ])
    );
  });

  it('uses the normal of the surface when it is connected', () => {
    const g = new GraphBuilder('custom-normal');
    g.surface({ shadingModel: 'phong', normal: g.uniform('up', T.vec3f) });
    const program = compile(g.build());
    expect(program.vertexInputs.map((input) => input.semantic)).toEqual([
      'position',
    ]);
  });
});
