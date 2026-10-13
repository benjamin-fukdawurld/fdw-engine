import { describe, expect, it } from 'vitest';
import { GraphBuilder } from '../graph/GraphBuilder';
import { std } from '../std';
import { compile } from './compile';
import type { IrEntryPoint, IrInstruction } from './ir';

const fragment = (program: ReturnType<typeof compile>) =>
  program.module.entryPoints.find(
    (candidate) => candidate.stage === 'fragment'
  ) as IrEntryPoint;

const instructions = (body: readonly IrInstruction[]): IrInstruction[] =>
  body.flatMap((instruction) =>
    instruction.op.kind === 'loop-sum'
      ? [instruction, ...instructions(instruction.op.body)]
      : [instruction]
  );

// The lighting pass of a deferred renderer: the surface read from the
// G-buffer, lit by a shading model called as a function.
const lightingPass = (shadingModel: string) => {
  const g = new GraphBuilder('deferred lighting');
  const uv = g.builtin('screen-uv');
  const read = (name: string) =>
    g.call(std.textureSample, {
      texture: g.texture(name),
      sampler: g.sampler(`${name}Sampler`),
      uv,
    });
  const normalDepth = read('normalDepth');
  const position = g.call('camera.positionFromDepth', {
    uv,
    viewDepth: normalDepth.swizzle('w'),
  });
  const lit = g.call(shadingModel, {
    baseColor: read('baseColor').swizzle('rgb'),
    normal: normalDepth.swizzle('xyz'),
    worldPosition: g.call(std.extend, { xyz: position, w: 1 }),
  });
  g.fullscreen({ color: lit });
  return g.build();
};

describe('shading models in full screen passes', () => {
  it('sums the lights of the frame, as in the scene passes', () => {
    const program = compile(lightingPass('lighting.phong'));
    const body = fragment(program).body;
    expect(body.some((instruction) => instruction.op.kind === 'loop-sum')).toBe(
      true
    );
    const frame = program.layout.groups.find((group) => group.slot === 'frame');
    const members =
      frame?.bindings[0]?.kind === 'uniform-block'
        ? frame.bindings[0].members.map((member) => member.name)
        : [];
    expect(members).toEqual(
      expect.arrayContaining([
        'inverseViewProjection',
        'view',
        'cameraPosition',
        'lightCount',
      ])
    );
  });

  it('reads the shadow atlas with the shadows feature only', () => {
    const reads = (features: Record<string, boolean>) =>
      instructions(
        fragment(compile(lightingPass('lighting.pbr'), { features })).body
      ).some((instruction) => instruction.op.kind === 'sample-compare');
    expect(reads({})).toBe(false);
    expect(reads({ shadows: true })).toBe(true);
  });
});
