import { describe, expect, it } from 'vitest';
import { GraphError } from '../graph/Diagnostic';
import { GraphBuilder } from '../graph/GraphBuilder';
import type { MaterialGraphData } from '../graph/MaterialGraphData';
import type { NodeDefinition } from '../graph/NodeDefinition';
import { createStandardRegistry, std, stdMacros } from '../std';
import { BuiltinTypes } from '../types/ShaderType';
import { CompiledProgram, compile, CompileOptions } from './compile';
import { forEachInstruction, IrEntryPoint, IrInstruction, IrOp } from './ir';

const stage = (program: CompiledProgram, name: 'vertex' | 'fragment') =>
  program.module.entryPoints.find(
    (entryPoint) => entryPoint.stage === name,
  ) as IrEntryPoint;
const ops = (entryPoint: IrEntryPoint, kind: IrOp['kind']) =>
  entryPoint.body.filter((instruction) => instruction.op.kind === kind);
const resources = (program: CompiledProgram) =>
  program.layout.groups.flatMap((group) =>
    group.bindings.map((binding) => binding.name),
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
      uv: g.attribute('uv', BuiltinTypes.vec2f),
    });
    const chosen = g.call(
      stdMacros.staticSwitch,
      {
        ifTrue: textured.swizzle('rgb'),
        ifFalse: g.uniform('color', BuiltinTypes.vec3f),
      },
      { params: { feature: 'useTexture' } },
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
      expect.arrayContaining(['map', 'mapSampler']),
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
        params: { semantic: 'color', type: BuiltinTypes.vec3f },
      },
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
    g.surface({ baseColor: g.uniform('color', BuiltinTypes.vec3f) });
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
        { name: 'value', type: BuiltinTypes.f32 },
        { name: 'index', type: BuiltinTypes.f32 },
      ],
      outputs: () => [{ name: 'result', type: BuiltinTypes.f32 }],
    } as NodeDefinition);
    return r;
  };

  const repeated = (count: number) => {
    const g = new GraphBuilder('repeat', registry());
    g.surface({
      alpha: g.call(
        stdMacros.repeat,
        { initial: g.uniform('start', BuiltinTypes.f32) },
        { params: { body: 'test.addIndex', count } },
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
      ops(fragment, 'constant').map((i) => (i.op as { value: number }).value),
    ).toEqual(expect.arrayContaining([0, 1, 2]));
  });

  it('returns the initial value for a count of zero', () => {
    const program = compile(repeated(0), { registry: registry() });
    expect(ops(stage(program, 'fragment'), 'binary')).toHaveLength(0);
  });

  it('reports invalid counts', () => {
    expect(errorOf(repeated(-1), { registry: registry() })).toMatch(
      /macro.repeat: count must be a non-negative integer, got -1/,
    );
  });

  it('reports function node types without implementation', () => {
    const r = registry();
    r.register({
      id: 'test.unimplemented',
      category: 'function',
      inputs: () => [{ name: 'value', type: BuiltinTypes.f32 }],
      outputs: () => [{ name: 'result', type: BuiltinTypes.f32 }],
    });
    const g = new GraphBuilder('unimplemented', r);
    g.surface({ alpha: g.call('test.unimplemented', { value: 1 }) });
    expect(errorOf(g.build(), { registry: r })).toMatch(
      /node type "test.unimplemented" has no implementation/,
    );
  });
});

describe('macro.normalMapping', () => {
  const graph = () => {
    const g = new GraphBuilder('normal-mapped');
    const sample = g.call(std.textureSample, {
      texture: g.texture('normalMap'),
      sampler: g.sampler('normalSampler'),
      uv: g.attribute('uv', BuiltinTypes.vec2f),
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
      'tangent',
    );
    expect(program.variantKey).toEqual({ 'hasAttribute.tangent': true });
    expect(
      ops(stage(program, 'fragment'), 'intrinsic').map((i) => i.op),
    ).toContainEqual({
      kind: 'intrinsic',
      name: 'cross',
    });
  });

  it('builds the frame from the derivatives without tangents', () => {
    const program = compile(graph(), { vertexAttributes: base });
    expect(program.vertexInputs.map((input) => input.semantic)).not.toContain(
      'tangent',
    );
    expect(program.variantKey).toEqual({
      'hasAttribute.tangent': false,
      'hasAttribute.uv': true,
    });
    const names = ops(stage(program, 'fragment'), 'intrinsic').map(
      (i) => (i.op as { name: string }).name,
    );
    expect(names).toEqual(expect.arrayContaining(['dpdx', 'dpdy']));
    expect(resources(program)).toContain('normalMap');
  });

  it('falls back on the interpolated normal without tangents nor uv', () => {
    const g = new GraphBuilder('no uv');
    const normal = g.call(stdMacros.normalMapping, {
      sample: [0.5, 0.5, 1],
    });
    g.surface({ shadingModel: 'phong', normal });
    const program = compile(g.build(), {
      vertexAttributes: ['position', 'normal'],
    });
    const names = ops(stage(program, 'fragment'), 'intrinsic').map(
      (i) => (i.op as { name: string }).name,
    );
    expect(names).not.toContain('dpdx');
  });
});

describe('surface details', () => {
  const heightMap = (g: GraphBuilder) => ({
    texture: g.texture('heightMap'),
    sampler: g.sampler('heightSampler'),
  });
  const intrinsics = (
    program: CompiledProgram,
    name: 'vertex' | 'fragment',
  ) => {
    const found: string[] = [];
    forEachInstruction(stage(program, name).body, (instruction) => {
      if (instruction.op.kind === 'intrinsic') {
        found.push(instruction.op.name);
      }
    });
    return found;
  };
  const samples = (program: CompiledProgram, name: 'vertex' | 'fragment') => {
    let count = 0;
    forEachInstruction(stage(program, name).body, (instruction) => {
      if (
        instruction.op.kind === 'sample' ||
        instruction.op.kind === 'sample-level'
      ) {
        count++;
      }
    });
    return count;
  };
  const attributes = ['position', 'normal', 'uv'];

  it('perturbs the normal by the derivatives of a height', () => {
    const g = new GraphBuilder('bumped');
    const height = g.call(std.sin, {
      x: g.call(std.mul, {
        a: g.attribute('uv', BuiltinTypes.vec2f).swizzle('x'),
        b: 40,
      }),
    });
    g.surface({
      shadingModel: 'phong',
      normal: g.call(stdMacros.bumpMapping, { height, scale: 0.01 }),
    });
    const program = compile(g.build(), { vertexAttributes: attributes });
    expect(intrinsics(program, 'fragment')).toEqual(
      expect.arrayContaining(['dpdx', 'dpdy', 'cross']),
    );
    expect(intrinsics(program, 'vertex')).not.toContain('dpdx');
  });

  it('rejects the derivatives outside of the fragment stage', () => {
    const g = new GraphBuilder('vertex derivative');
    g.surface({
      positionOffset: g.call(std.dpdx, {
        x: g.attribute('position', BuiltinTypes.vec3f),
      }),
    });
    expect(errorOf(g.build(), { vertexAttributes: attributes })).toMatch(
      /fragment/,
    );
  });

  it('shifts the uv by one read of the height map', () => {
    const g = new GraphBuilder('parallax');
    const uv = g.call(stdMacros.parallaxMapping, heightMap(g));
    g.surface({ baseColor: g.call(std.vec3, { x: uv.swizzle('x') }) });
    const program = compile(g.build(), { vertexAttributes: attributes });
    expect(samples(program, 'fragment')).toBe(1);
  });

  it('unrolls the steps of parallax occlusion mapping', () => {
    const g = new GraphBuilder('pom');
    const uv = g.call(stdMacros.parallaxOcclusionMapping, heightMap(g), {
      params: { steps: 8 },
    });
    g.surface({ baseColor: g.call(std.vec3, { x: uv.swizzle('x') }) });
    const program = compile(g.build(), { vertexAttributes: attributes });
    // A read per step, and one at the start.
    expect(samples(program, 'fragment')).toBe(9);
  });

  it('displaces the vertices by a height read in the vertex stage', () => {
    const g = new GraphBuilder('displaced');
    g.surface({
      positionOffset: g.call(stdMacros.displacement, {
        ...heightMap(g),
        scale: 0.2,
      }),
    });
    const program = compile(g.build(), { vertexAttributes: attributes });
    expect(samples(program, 'vertex')).toBe(1);
    expect(samples(program, 'fragment')).toBe(0);
  });
});

describe('lighting.phong', () => {
  const phong = () => {
    const g = new GraphBuilder('phong');
    g.surface({
      shadingModel: 'phong',
      baseColor: g.uniform('color', BuiltinTypes.vec3f),
      shininess: g.uniform('shininess', BuiltinTypes.f32),
    });
    return g.build();
  };

  const members = (body: readonly IrInstruction[]) =>
    body
      .filter((i) => i.op.kind === 'load-resource')
      .map((i) => (i.op as { member?: string }).member);
  const intrinsics = (body: readonly IrInstruction[]) =>
    body
      .filter((i) => i.op.kind === 'intrinsic')
      .map((i) => (i.op as { name: string }).name);

  it('sums the lighting over the lights of the frame', () => {
    const program = compile(phong());
    const fragment = stage(program, 'fragment');
    const [loop] = ops(fragment, 'loop-sum');
    const op = loop?.op;
    if (op?.kind !== 'loop-sum') {
      throw new Error('expected a light loop');
    }
    // The count of lights is read before the loop.
    const count = fragment.body.find((i) => i.id === loop.args[0]);
    expect(count?.op).toEqual({
      kind: 'load-resource',
      binding: 'frameUniforms',
      member: 'lightCount',
    });
    // The light is read from the pool in the loop: its 7 first vec4, from
    // the vec4 of the index.
    const pool = op.body.find(
      (i) => i.op.kind === 'load-resource' && i.op.binding === 'lights',
    );
    expect(
      op.body.filter((i) => i.op.kind === 'index' && i.args[0] === pool?.id),
    ).toHaveLength(7);
    const first = op.body.find(
      (i) => i.op.kind === 'binary' && i.op.operator === '*',
    );
    expect(first?.args[0]).toBe(op.index);
    // What does not depend on the light is computed once, before the loop:
    // the camera position, the normal, the view direction and the clamped
    // shininess.
    expect(members(fragment.body)).toContain('cameraPosition');
    expect(members(op.body)).not.toContain('cameraPosition');
    expect(intrinsics(fragment.body).sort()).toEqual([
      'max',
      'normalize',
      'normalize',
    ]);
    expect(intrinsics(op.body)).toEqual(
      expect.arrayContaining(['normalize', 'dot', 'reflect', 'pow', 'length']),
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
      BuiltinTypes.vec4f,
      BuiltinTypes.vec3f,
      BuiltinTypes.vec4f,
    ]);
    const all: IrInstruction[] = [];
    forEachInstruction(stage(program, 'fragment').body, (i) => all.push(i));
    expect(intrinsics(all)).toEqual(
      expect.arrayContaining([
        'normalize',
        'dot',
        'reflect',
        'pow',
        'step',
        'length',
      ]),
    );
  });

  it('uses the normal of the surface when it is connected', () => {
    const g = new GraphBuilder('custom-normal');
    g.surface({
      shadingModel: 'phong',
      normal: g.uniform('up', BuiltinTypes.vec3f),
    });
    const program = compile(g.build());
    expect(program.vertexInputs.map((input) => input.semantic)).toEqual([
      'position',
    ]);
  });
});
