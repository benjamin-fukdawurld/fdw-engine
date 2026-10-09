import { describe, expect, it } from 'vitest';
import { GraphBuilder } from '../graph/GraphBuilder';
import { std } from '../std';
import { BuiltinTypes } from '../types/ShaderType';
import { compile } from './compile';
import type { IrEntryPoint } from './ir';

const entryPoint = (
  program: ReturnType<typeof compile>,
  stage: IrEntryPoint['stage']
) =>
  program.module.entryPoints.find(
    (candidate) => candidate.stage === stage
  ) as IrEntryPoint;

const postProcess = () => {
  const g = new GraphBuilder('invert');
  const texel = g.call(std.textureSample, {
    texture: g.texture('source'),
    sampler: g.sampler('sourceSampler'),
    uv: g.builtin('screen-uv'),
  });
  g.fullscreen({
    color: g.call(std.extend, {
      xyz: g.call(std.sub, { a: 1, b: texel.swizzle('rgb') }),
      w: 1,
    }),
  });
  return g.build();
};

describe('output.fullscreen', () => {
  it('draws a triangle from the vertex index, without mesh', () => {
    const program = compile(postProcess());
    expect(program.vertexInputs).toEqual([]);
    const vertex = entryPoint(program, 'vertex');
    expect(vertex.inputs).toEqual([]);
    expect(
      vertex.body.some(
        (i) => i.op.kind === 'load-builtin' && i.op.builtin === 'vertex-index'
      )
    ).toBe(true);
    // The material resources, in the usual groups.
    const material = program.layout.groups.find(
      (group) => group.slot === 'material'
    );
    expect(material?.bindings.map((binding) => binding.name)).toEqual([
      'source',
      'sourceSampler',
    ]);
  });

  it('passes screen-uv to the fragment stage as a varying', () => {
    const program = compile(postProcess());
    const vertex = entryPoint(program, 'vertex');
    const fragment = entryPoint(program, 'fragment');
    const uv = fragment.inputs.find(
      (input) => input.type.kind === 'vector' && input.type.size === 2
    );
    expect(uv).toBeDefined();
    expect(vertex.outputs.map((output) => output.name)).toContain(uv?.name);
    expect(fragment.outputs).toHaveLength(1);
  });

  it('rejects screen-uv outside full screen graphs', () => {
    const g = new GraphBuilder('surface');
    const uv = g.builtin('screen-uv');
    g.surface({
      baseColor: g.call(std.vec3, {
        x: uv.swizzle('x'),
        y: uv.swizzle('y'),
        z: 0,
      }),
    });
    expect(() => compile(g.build())).toThrow(/screen-uv is only available/);
  });

  it('accepts constant colors and engine values', () => {
    const g = new GraphBuilder('fade');
    const exposure = g.engine('exposure');
    g.fullscreen({
      color: g.call(std.extend, {
        xyz: g.call(std.mul, { a: [1, 1, 1], b: exposure }),
        w: 1,
      }),
    });
    const program = compile(g.build());
    const fragment = entryPoint(program, 'fragment');
    expect(
      fragment.body.some(
        (i) => i.op.kind === 'load-resource' && i.op.member === 'exposure'
      )
    ).toBe(true);
    expect(fragment.outputs[0].type).toEqual(BuiltinTypes.vec4f);
  });
});
