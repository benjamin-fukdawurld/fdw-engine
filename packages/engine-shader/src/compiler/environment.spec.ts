import { describe, expect, it } from 'vitest';
import { GraphBuilder } from '../graph/GraphBuilder';
import { std } from '../std';
import { BuiltinTypes } from '../types/ShaderType';
import { compile } from './compile';
import { forEachInstruction, IrEntryPoint, IrInstruction } from './ir';

const lit = (shadingModel: string) => {
  const g = new GraphBuilder('lit');
  g.surface({ shadingModel, baseColor: [1, 0.5, 0.25] });
  return g.build();
};

const attributes = ['position', 'normal'];

const frameBindings = (program: ReturnType<typeof compile>) =>
  program.layout.groups
    .find((group) => group.slot === 'frame')
    ?.bindings.map((binding) => binding.name);

const fragment = (program: ReturnType<typeof compile>) => {
  const all: IrInstruction[] = [];
  forEachInstruction(
    (
      program.module.entryPoints.find(
        (entryPoint) => entryPoint.stage === 'fragment',
      ) as IrEntryPoint
    ).body,
    (instruction) => all.push(instruction),
  );
  return all;
};

describe('environment', () => {
  it('costs nothing without the environment feature', () => {
    for (const model of ['phong', 'pbr']) {
      const program = compile(lit(model), { vertexAttributes: attributes });
      expect(frameBindings(program)).not.toContain('environmentMap');
      expect(fragment(program).some((i) => i.op.kind === 'sample-level')).toBe(
        false,
      );
    }
  });

  it('lights the lit shading models with the prefiltered atlas', () => {
    for (const model of ['phong', 'pbr']) {
      const program = compile(lit(model), {
        vertexAttributes: attributes,
        features: { environment: true },
      });
      expect(program.variantKey).toMatchObject({ environment: true });
      expect(frameBindings(program)).toEqual([
        'frameUniforms',
        'lights',
        'environmentMap',
        'environmentSampler',
      ]);
      const instructions = fragment(program);
      // Two levels of radiance, the irradiance, the scale and bias: four
      // lookups at level 0 (the atlas has no levels).
      expect(
        instructions.filter((i) => i.op.kind === 'sample-level'),
      ).toHaveLength(4);
      expect(
        instructions.some(
          (i) => i.op.kind === 'load-resource' && i.op.member === 'environment',
        ),
      ).toBe(true);
    }
  });

  it('maps directions to panoramas with atan2 and acos', () => {
    const g = new GraphBuilder('panorama');
    const uv = g.call('environment.equirect', {
      direction: g.call(std.perFragment, {
        value: g.attribute('normal', BuiltinTypes.vec3f),
      }),
    });
    g.surface({
      baseColor: g
        .call(std.extend, {
          xyz: g.call(std.vec3, {
            x: uv.swizzle('x'),
            y: uv.swizzle('y'),
            z: 0,
          }),
          w: 1,
        })
        .swizzle('xyz'),
    });
    const names = fragment(compile(g.build()))
      .filter((i) => i.op.kind === 'intrinsic')
      .map((i) => (i.op as { name: string }).name);
    expect(names).toEqual(expect.arrayContaining(['atan2', 'acos']));
  });
});
