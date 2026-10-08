import { describe, expect, it } from 'vitest';
import { GraphBuilder } from '../graph/GraphBuilder';
import { std } from '../std';
import { BuiltinTypes } from '../types/ShaderType';
import { compile } from './compile';
import type { IrEntryPoint } from './ir';

const graph = () => {
  const g = new GraphBuilder('masked');
  const color = g.uniform('color', BuiltinTypes.vec4f);
  g.surface({ baseColor: color.swizzle('rgb'), alpha: color.swizzle('a') });
  return g.build();
};

const fragmentOf = (program: ReturnType<typeof compile>) =>
  program.module.entryPoints.find(
    (entryPoint) => entryPoint.stage === 'fragment'
  ) as IrEntryPoint;

describe('alphaMode: mask', () => {
  it('discards the fragments below the alpha cutoff', () => {
    const program = compile(graph(), { features: { alphaMode: 'mask' } });
    const fragment = fragmentOf(program);
    const discard = fragment.body.find(
      (i) => i.id === fragment.results['discard']
    );
    expect(discard?.op).toEqual({ kind: 'compare', operator: '<' });
    expect(discard?.type).toEqual(BuiltinTypes.bool);
    // alpha < alphaCutoff, the cutoff being a material uniform.
    const [, cutoff] = (discard?.args ?? []).map((id) =>
      fragment.body.find((i) => i.id === id)
    );
    expect(cutoff?.op).toEqual({
      kind: 'load-resource',
      binding: 'materialUniforms',
      member: 'alphaCutoff',
    });
    expect(program.variantKey).toEqual({ alphaMode: 'mask' });
  });

  it('only discards in the mask variant', () => {
    const opaque = compile(graph(), { features: { alphaMode: 'opaque' } });
    const masked = compile(graph(), { features: { alphaMode: 'mask' } });
    expect(fragmentOf(opaque).results['discard']).toBeUndefined();
    expect(opaque.programKey).not.toBe(masked.programKey);
    // Opaque and blended materials share their program.
    const blend = compile(graph(), { features: { alphaMode: 'blend' } });
    expect(blend.programKey).toBe(opaque.programKey);
  });

  it('lets raw graphs discard through output.fragment', () => {
    const g = new GraphBuilder('raw');
    const clipPosition = g.call(std.extend, {
      xyz: g.attribute('position', BuiltinTypes.vec3f),
      w: 1,
    });
    g.node('output.vertex', { inputs: { clipPosition } });
    const value = g.uniform('value', BuiltinTypes.f32);
    g.node('output.fragment', {
      inputs: {
        color: [1, 1, 1, 1],
        discard: g.call(std.greater, { a: value, b: 0.5 }),
      },
    });
    const fragment = fragmentOf(compile(g.build()));
    expect(fragment.results['discard']).toBeDefined();
  });
});

describe('comparisons', () => {
  it('compare component-wise, giving booleans of the same shape', () => {
    const g = new GraphBuilder('compare');
    const a = g.uniform('a', BuiltinTypes.vec3f);
    const less = g.call(std.less, { a, b: 0.5 });
    expect(less.type).toEqual({ kind: 'vector', size: 3, scalar: 'bool' });
    g.surface({
      baseColor: g.call(std.select, {
        ifFalse: a,
        ifTrue: [1, 0, 0],
        condition: g.call(std.less, { a: a.swizzle('x'), b: 0.5 }),
      }),
    });
    const fragment = fragmentOf(compile(g.build()));
    expect(
      fragment.body.some(
        (i) => i.op.kind === 'compare' && i.type.kind === 'scalar'
      )
    ).toBe(true);
  });
});
