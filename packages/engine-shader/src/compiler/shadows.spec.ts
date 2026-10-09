import { describe, expect, it } from 'vitest';
import { GraphBuilder } from '../graph/GraphBuilder';
import { std } from '../std';
import { BuiltinTypes } from '../types/ShaderType';
import { compile } from './compile';
import { forEachInstruction, IrEntryPoint, IrInstruction } from './ir';

const lit = (shadingModel = 'phong') => {
  const g = new GraphBuilder('lit');
  g.surface({
    shadingModel,
    baseColor: g.uniform('color', BuiltinTypes.vec3f),
    alpha: g.uniform('opacity', BuiltinTypes.f32),
  });
  return g.build();
};

const attributes = { vertexAttributes: ['position', 'normal'] };

const stage = (
  program: ReturnType<typeof compile>,
  name: IrEntryPoint['stage']
) =>
  program.module.entryPoints.find(
    (entryPoint) => entryPoint.stage === name
  ) as IrEntryPoint;

const instructions = (entryPoint: IrEntryPoint) => {
  const all: IrInstruction[] = [];
  forEachInstruction(entryPoint.body, (instruction) => all.push(instruction));
  return all;
};

const frameBindings = (program: ReturnType<typeof compile>) =>
  program.layout.groups
    .find((group) => group.slot === 'frame')
    ?.bindings.map((binding) => binding.name);

describe('shadows', () => {
  it('cost nothing without the shadows feature', () => {
    const program = compile(lit(), attributes);
    expect(frameBindings(program)).toEqual(['frameUniforms']);
    expect(
      instructions(stage(program, 'fragment')).some(
        (i) => i.op.kind === 'sample-compare'
      )
    ).toBe(false);
  });

  it('filter 3 × 3 comparisons with the shadow atlas, per light', () => {
    for (const model of ['phong', 'pbr']) {
      const program = compile(lit(model), {
        ...attributes,
        features: { shadows: true },
      });
      expect(program.variantKey).toMatchObject({ shadows: true });
      // The atlas and its comparison sampler, after the frame uniforms.
      expect(frameBindings(program)).toEqual([
        'frameUniforms',
        'shadowMap',
        'shadowSampler',
      ]);
      const loop = stage(program, 'fragment').body.find(
        (i) => i.op.kind === 'loop-sum'
      );
      const body =
        loop?.op.kind === 'loop-sum' ? (loop.op.body as IrInstruction[]) : [];
      const compares = body.filter((i) => i.op.kind === 'sample-compare');
      expect(compares).toHaveLength(9);
      expect(compares[0].type).toEqual(BuiltinTypes.f32);
      // The shadow matrices are a mat4 per light.
      expect(
        body.some(
          (i) =>
            i.op.kind === 'load-resource' &&
            i.op.member === 'lightShadowMatrices'
        )
      ).toBe(true);
    }
  });

  it('do not change the unlit programs', () => {
    const plain = compile(lit('unlit'), attributes);
    const shadowed = compile(lit('unlit'), {
      ...attributes,
      features: { shadows: true },
    });
    expect(shadowed.programKey).toBe(plain.programKey);
  });

  it('compare depths with depth textures and comparison samplers only', () => {
    const g = new GraphBuilder('wrong');
    expect(() =>
      g.call(std.textureSampleCompare, {
        texture: g.texture('color'),
        sampler: g.sampler('colorSampler'),
        uv: [0, 0],
        depthRef: 0.5,
      })
    ).toThrow();
    const valid = g.call(std.textureSampleCompare, {
      texture: g.texture('depth', { sampleType: 'depth' }),
      sampler: g.sampler('depthSampler', { comparison: true }),
      uv: [0, 0],
      depthRef: 0.5,
    });
    expect(valid.type).toEqual(BuiltinTypes.f32);
  });
});

describe('depthOnly', () => {
  it('writes no color and leaves the shading model out', () => {
    const program = compile(lit('pbr'), {
      ...attributes,
      features: { depthOnly: true, shadows: true },
    });
    const fragment = stage(program, 'fragment');
    expect(fragment.outputs).toEqual([]);
    expect(fragment.body).toEqual([]);
    // Neither normals nor lights: the position only.
    expect(program.vertexInputs.map((input) => input.semantic)).toEqual([
      'position',
    ]);
    expect(frameBindings(program)).toEqual(['frameUniforms']);
  });

  it('keeps the discard of masked materials', () => {
    const program = compile(lit(), {
      ...attributes,
      features: { depthOnly: true, alphaMode: 'mask' },
    });
    const fragment = stage(program, 'fragment');
    expect(fragment.outputs).toEqual([]);
    expect(fragment.results['discard']).toBeDefined();
  });
});
