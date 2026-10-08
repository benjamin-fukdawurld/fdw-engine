import { describe, expect, it } from 'vitest';
import { GraphError } from '../graph/Diagnostic';
import { GraphBuilder } from '../graph/GraphBuilder';
import type { MaterialGraphData } from '../graph/MaterialGraphData';
import { std } from '../std';
import { BuiltinTypes } from '../types/ShaderType';
import { CompiledProgram, compile } from './compile';
import type { IrEntryPoint, IrOp } from './ir';

const stage = (program: CompiledProgram, name: 'vertex' | 'fragment') =>
  program.module.entryPoints.find(
    (entryPoint) => entryPoint.stage === name
  ) as IrEntryPoint;

const ops = (entryPoint: IrEntryPoint, kind: IrOp['kind']) =>
  entryPoint.body.filter((instruction) => instruction.op.kind === kind);

const texturedUnlit = (
  options: { tintDefault?: number[]; extra?: boolean } = {}
) => {
  const g = new GraphBuilder('textured-unlit');
  const uv = g.attribute('uv', BuiltinTypes.vec2f);
  const texel = g.call(std.textureSample, {
    texture: g.texture('diffuseMap'),
    sampler: g.sampler('diffuseSampler'),
    uv,
  });
  const tint = g.uniform('tint', BuiltinTypes.vec4f, {
    default: options.tintDefault ?? [1, 1, 1, 1],
  });
  const color = g.call(std.mul, { a: texel, b: tint }, { label: 'color' });
  if (options.extra) {
    // Dead code: not connected to the surface.
    g.call(std.add, { a: g.uniform('unused', BuiltinTypes.f32), b: 1 });
  }
  g.surface({ baseColor: color.swizzle('rgb'), alpha: color.swizzle('a') });
  return g.build();
};

const compileError = (
  graph: MaterialGraphData,
  options?: Parameters<typeof compile>[1]
): string => {
  try {
    compile(graph, options);
  } catch (error) {
    expect(error).toBeInstanceOf(GraphError);
    return (error as GraphError).message;
  }
  throw new Error('expected a GraphError');
};

describe('compile', () => {
  describe('surface lowering (unlit)', () => {
    it('produces the standard vertex stage', () => {
      const program = compile(texturedUnlit());
      const vertex = stage(program, 'vertex');

      expect(program.vertexInputs).toEqual([
        {
          semantic: 'position',
          type: BuiltinTypes.vec3f,
          location: 0,
          name: 'a_position',
        },
        { semantic: 'uv', type: BuiltinTypes.vec2f, location: 1, name: 'a_uv' },
      ]);
      expect(ops(vertex, 'load-resource').map((i) => i.op)).toEqual([
        { kind: 'load-resource', binding: 'objectUniforms', member: 'world' },
        {
          kind: 'load-resource',
          binding: 'frameUniforms',
          member: 'viewProjection',
        },
      ]);
      // world × position, then viewProjection × world position.
      expect(ops(vertex, 'binary')).toHaveLength(2);
      expect(vertex.outputs.map((output) => output.name)).toEqual([
        'clipPosition',
        'v_uv',
      ]);
    });

    it('rejects unknown shading models', () => {
      const g = new GraphBuilder('toon');
      expect(() => g.surface({ shadingModel: 'toon' })).toThrow(
        /unknown shading model "toon" \(no lighting.toon node type\)/
      );
    });

    it('adds the position offset only when it is connected', () => {
      const g = new GraphBuilder('offset');
      g.surface({ positionOffset: g.uniform('offset', BuiltinTypes.vec3f) });
      expect(ops(stage(compile(g.build()), 'vertex'), 'binary')).toHaveLength(
        3
      );
    });
  });

  describe('raw outputs', () => {
    it('compiles output.vertex and output.fragment directly', () => {
      const g = new GraphBuilder('fullscreen');
      g.node('output.vertex', {
        inputs: {
          clipPosition: g.call(std.extend, {
            xyz: g.attribute('position', BuiltinTypes.vec3f),
          }),
        },
      });
      g.node('output.fragment', { inputs: { color: [0, 0, 1, 1] } });
      const program = compile(g.build());
      expect(stage(program, 'fragment').body.map((i) => i.op.kind)).toEqual([
        'constant',
      ]);
      expect(program.layout.groups.map((group) => group.slot)).toEqual([
        'frame',
        'material',
        'object',
      ]);
    });

    it('rejects a clip position computed from fragment-only values', () => {
      const g = new GraphBuilder('invalid');
      g.node('output.vertex', {
        inputs: { clipPosition: g.builtin('frag-coord') },
      });
      g.node('output.fragment', { inputs: { color: [1, 1, 1, 1] } });
      expect(compileError(g.build())).toMatch(
        /only available in the fragment stage/
      );
    });
  });

  describe('optimizations', () => {
    it('removes dead code, including its resources', () => {
      const program = compile(texturedUnlit({ extra: true }));
      const material = program.layout.groups.find(
        (group) => group.slot === 'material'
      );
      expect(material?.bindings.map((binding) => binding.name)).toEqual([
        'materialUniforms',
        'diffuseMap',
        'diffuseSampler',
      ]);
      expect(JSON.stringify(material)).not.toContain('unused');
    });

    it('folds constant expressions', () => {
      const g = new GraphBuilder('folding');
      const half = g.call(std.mul, {
        a: g.constant(BuiltinTypes.f32, 0.25),
        b: 2,
      });
      const color = g.call(std.mix, { a: [0, 0, 0], b: [1, 1, 1], t: half });
      g.surface({
        baseColor: g.call(std.normalize, {
          x: g.call(std.add, { a: color, b: [0.5, 0, 0] }),
        }),
      });
      const fragment = stage(compile(g.build()), 'fragment');
      // mix → add → normalize → extend: the whole color is folded into one
      // constant.
      expect(fragment.body).toHaveLength(1);
      const { op } = fragment.body[0];
      if (op.kind !== 'constant') {
        throw new Error(`expected a constant, got ${op.kind}`);
      }
      const value = op.value as readonly number[];
      const length = Math.sqrt(1.5);
      [1 / length, 0.5 / length, 0.5 / length, 1].forEach((expected, i) =>
        expect(value[i]).toBeCloseTo(expected, 6)
      );
    });

    it('does not fold divisions by zero', () => {
      const g = new GraphBuilder('division');
      g.surface({
        alpha: g.call(std.div, { a: g.constant(BuiltinTypes.f32, 1), b: 0 }),
      });
      expect(ops(stage(compile(g.build()), 'fragment'), 'binary')).toHaveLength(
        1
      );
    });

    it('merges identical nodes', () => {
      const g = new GraphBuilder('cse');
      const a = g.call(std.mul, {
        a: g.uniform('tint', BuiltinTypes.vec3f),
        b: 2,
      });
      const b = g.call(std.mul, {
        a: g.uniform('tint', BuiltinTypes.vec3f),
        b: 2,
      });
      g.surface({ baseColor: g.call(std.add, { a, b }) });
      const fragment = stage(compile(g.build()), 'fragment');
      expect(ops(fragment, 'load-resource')).toHaveLength(1);
      expect(ops(fragment, 'binary').map((i) => i.op)).toEqual([
        { kind: 'binary', operator: '*' },
        { kind: 'binary', operator: '+' },
      ]);
    });
  });

  describe('stages', () => {
    it('samples textures in the fragment stage and interpolates the uv', () => {
      const program = compile(texturedUnlit());
      const fragment = stage(program, 'fragment');
      expect(ops(fragment, 'sample')).toHaveLength(1);
      expect(ops(fragment, 'load-input').map((i) => i.op)).toEqual([
        { kind: 'load-input', input: 'v_uv' },
      ]);
      expect(ops(stage(program, 'vertex'), 'sample')).toHaveLength(0);
    });

    it('computes per-vertex values in the vertex stage', () => {
      const g = new GraphBuilder('per-vertex');
      const normal = g.attribute('normal', BuiltinTypes.vec3f);
      g.surface({
        baseColor: g.call(std.normalize, { x: normal }, { label: 'n' }),
      });
      const program = compile(g.build());
      // Everything depends on per-vertex values only: the whole color is
      // computed in the vertex stage and interpolated.
      expect(
        ops(stage(program, 'vertex'), 'intrinsic').map((i) => i.name)
      ).toEqual(['n']);
      expect(ops(stage(program, 'fragment'), 'intrinsic')).toEqual([]);
      expect(stage(program, 'fragment').body.map((i) => i.op.kind)).toEqual([
        'load-input',
      ]);
    });

    it('recomputes uniform values in the fragment stage instead of interpolating them', () => {
      const g = new GraphBuilder('uniform');
      g.surface({ baseColor: g.uniform('color', BuiltinTypes.vec3f) });
      const program = compile(g.build());
      expect(stage(program, 'vertex').outputs).toHaveLength(1);
      expect(ops(stage(program, 'fragment'), 'load-resource')).toHaveLength(1);
    });

    it('uses flat interpolation for integers', () => {
      const g = new GraphBuilder('flat');
      const id = g.attribute('materialId', BuiltinTypes.u32);
      // select() depends on a fragment-only builtin: the u32 has to cross.
      const chosen = g.call(std.select, {
        ifFalse: id,
        ifTrue: 0,
        condition: g.builtin('front-facing'),
      });
      g.surface({
        alpha: g.call(
          std.convert,
          { value: chosen },
          { params: { to: BuiltinTypes.f32 } }
        ),
      });
      const vertex = stage(compile(g.build()), 'vertex');
      expect(vertex.outputs[1]).toEqual(
        expect.objectContaining({
          name: 'v_materialId',
          type: BuiltinTypes.u32,
          interpolation: 'flat',
        })
      );
    });

    it('computes values that cannot be interpolated in the fragment stage', () => {
      const g = new GraphBuilder('bool');
      const level = g.attribute('level', BuiltinTypes.u32);
      const enabled = g.call(
        std.convert,
        { value: level },
        { params: { to: BuiltinTypes.bool } }
      );
      const texel = g.call(std.textureSample, {
        texture: g.texture('map'),
        sampler: g.sampler('mapSampler'),
        uv: g.attribute('uv', BuiltinTypes.vec2f),
      });
      // The select() is per fragment (texture sample) and needs a bool
      // computed from a vertex attribute: the u32 crosses, not the bool.
      g.surface({
        baseColor: g.call(std.select, {
          ifFalse: [0, 0, 0],
          ifTrue: texel.swizzle('rgb'),
          condition: enabled,
        }),
      });
      const program = compile(g.build());
      expect(
        stage(program, 'vertex').outputs.map((output) => output.type)
      ).toEqual([BuiltinTypes.vec4f, BuiltinTypes.u32, BuiltinTypes.vec2f]);
      expect(
        ops(stage(program, 'fragment'), 'convert').map((i) => i.type)
      ).toEqual([BuiltinTypes.bool]);
    });

    it('enforces the varying limit', () => {
      const g = new GraphBuilder('varyings');
      const texel = g.call(std.textureSample, {
        texture: g.texture('map'),
        sampler: g.sampler('mapSampler'),
        uv: g.attribute('uv', BuiltinTypes.vec2f),
      });
      g.surface({
        baseColor: g.call(std.mul, {
          a: texel.swizzle('rgb'),
          b: g.attribute('color', BuiltinTypes.vec3f),
        }),
      });
      expect(
        compileError(g.build(), { capabilities: { maxVaryings: 1 } })
      ).toMatch(/needs 2 varyings, but the backend supports 1/);
    });
  });

  describe('layout', () => {
    it('always has the frame, material and object groups, then the custom slots', () => {
      const g = new GraphBuilder('slots');
      g.surface({
        baseColor: g.call(std.add, {
          a: g.uniform('a', BuiltinTypes.vec3f, { slot: 'zone' }),
          b: g.uniform('b', BuiltinTypes.vec3f, { slot: 'atmosphere' }),
        }),
      });
      const layout = compile(g.build()).layout;
      expect(layout.groups.map((group) => group.slot)).toEqual([
        'frame',
        'material',
        'object',
        'atmosphere',
        'zone',
      ]);
      expect(layout.groups[0].bindings).toEqual([
        expect.objectContaining({
          kind: 'uniform-block',
          name: 'frameUniforms',
        }),
      ]);
    });

    it('sorts the material resources by kind and name', () => {
      const g = new GraphBuilder('sorted');
      const uv = g.attribute('uv', BuiltinTypes.vec2f);
      const sample = (name: string) =>
        g.call(std.textureSample, {
          texture: g.texture(`${name}Map`),
          sampler: g.sampler(`${name}Sampler`),
          uv,
        });
      const color = g.call(std.mul, {
        a: g.call(std.add, { a: sample('specular'), b: sample('diffuse') }),
        b: g.call(std.add, {
          a: g.uniform('zTint', BuiltinTypes.vec4f),
          b: g.uniform('aTint', BuiltinTypes.vec4f),
        }),
      });
      g.surface({ baseColor: color.swizzle('rgb') });
      const material = compile(g.build()).layout.groups[1];
      expect(material.bindings.map((binding) => binding.name)).toEqual([
        'materialUniforms',
        'diffuseMap',
        'specularMap',
        'diffuseSampler',
        'specularSampler',
      ]);
      expect(material.bindings[0]).toEqual(
        expect.objectContaining({
          members: [
            { name: 'aTint', type: BuiltinTypes.vec4f },
            { name: 'zTint', type: BuiltinTypes.vec4f },
          ],
        })
      );
    });
  });

  describe('unsupported or reserved features', () => {
    it.each([
      [
        'storage buffers',
        (g: GraphBuilder) => g.storage('lights', BuiltinTypes.vec4f),
        /storage buffers are not supported yet/,
      ],
      [
        'the engine slots',
        (g: GraphBuilder) =>
          g.uniform('exposure', BuiltinTypes.f32, { slot: 'frame' }),
        /slot "frame" is reserved/,
      ],
      [
        'bool uniforms',
        (g: GraphBuilder) => g.uniform('enabled', BuiltinTypes.bool),
        /bool is not allowed in uniform buffers/,
      ],
      [
        'reserved names',
        (g: GraphBuilder) => g.uniform('materialUniforms', BuiltinTypes.f32),
        /reserved for uniform blocks/,
      ],
    ])('rejects %s', (_, declare, message) => {
      const g = new GraphBuilder('unsupported');
      declare(g);
      g.surface();
      expect(compileError(g.build())).toMatch(message);
    });

    it('checks that the mesh provides the attributes', () => {
      expect(
        compileError(texturedUnlit(), {
          vertexAttributes: ['position', 'normal'],
        })
      ).toMatch(/does not provide the "uv" attribute/);
      expect(() =>
        compile(texturedUnlit(), { vertexAttributes: ['position', 'uv'] })
      ).not.toThrow();
    });
  });

  describe('programKey', () => {
    it('is stable and independent of the uniform values', () => {
      const key = compile(texturedUnlit()).programKey;
      expect(key).toMatch(/^[0-9a-f]{16}$/);
      expect(compile(texturedUnlit()).programKey).toBe(key);
      expect(
        compile(texturedUnlit({ tintDefault: [1, 0, 0, 1] })).programKey
      ).toBe(key);
      expect(compile(texturedUnlit({ extra: true })).programKey).toBe(key);
    });

    it('does not depend on the node ids', () => {
      const graph = texturedUnlit();
      const renamed: MaterialGraphData = {
        ...graph,
        nodes: [...graph.nodes]
          .reverse()
          .map((node) => ({ ...node, id: `x_${node.id}` })),
        edges: graph.edges.map((edge) => ({
          ...edge,
          from: { ...edge.from, node: `x_${edge.from.node}` },
          to: { ...edge.to, node: `x_${edge.to.node}` },
        })),
      };
      expect(compile(renamed).programKey).toBe(compile(graph).programKey);
    });

    it('changes with the structure of the graph', () => {
      const constant = (value: number) => {
        const g = new GraphBuilder('constant');
        g.surface({ alpha: value });
        return compile(g.build()).programKey;
      };
      expect(constant(0.5)).not.toBe(constant(1));
    });
  });
});
