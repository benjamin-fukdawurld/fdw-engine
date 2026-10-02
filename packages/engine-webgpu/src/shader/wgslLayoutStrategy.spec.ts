import { compile, GraphBuilder, std, T } from '@fdw/engine-shader';
import { describe, expect, it } from 'vitest';
import { wgslLayoutStrategy } from './wgslLayoutStrategy';

const program = () => {
  const g = new GraphBuilder('layout');
  const uv = g.attribute('uv', T.vec2f);
  const texel = g.call(std.textureSample, {
    texture: g.texture('diffuseMap'),
    sampler: g.sampler('diffuseSampler'),
    uv,
  });
  const scale = g.uniform('scale', T.f32);
  const tint = g.uniform('tint', T.vec3f);
  const color = g.call(std.mul, {
    a: g.call(std.mul, { a: texel.swizzle('rgb'), b: tint }),
    b: scale,
  });
  g.surface({
    baseColor: color,
    alpha: g.call(
      std.convert,
      { value: g.uniform('mode', T.u32, { slot: 'pass' }) },
      { params: { to: T.f32 } }
    ),
  });
  return compile(g.build());
};

describe('wgslLayoutStrategy', () => {
  const layout = wgslLayoutStrategy.resolve(program().layout);
  const group = (slot: string) =>
    layout.groups.find((candidate) => candidate.slot === slot)!;
  const block = (slot: string) => group(slot).bindings[0].block!;
  const offsets = (slot: string) =>
    block(slot).members.map((member) => [
      member.name,
      member.offset,
      member.size,
    ]);

  it('numbers the groups in slot order and the bindings in layout order', () => {
    expect(layout.groups.map((g) => [g.index, g.slot])).toEqual([
      [0, 'frame'],
      [1, 'material'],
      [2, 'object'],
      [3, 'pass'],
    ]);
    expect(
      group('material').bindings.map((binding) => [
        binding.binding,
        binding.resource.name,
      ])
    ).toEqual([
      [0, 'materialUniforms'],
      [1, 'diffuseMap'],
      [2, 'diffuseSampler'],
    ]);
  });

  it('lays out the frame block with the WGSL uniform rules', () => {
    // time fits in the padding of the vec3 cameraPosition.
    expect(offsets('frame')).toEqual([
      ['viewProjection', 0, 64],
      ['view', 64, 64],
      ['projection', 128, 64],
      ['cameraPosition', 192, 12],
      ['time', 204, 4],
    ]);
    expect(block('frame').size).toBe(208);
  });

  it('pads the mat3 columns of the object block', () => {
    expect(offsets('object')).toEqual([
      ['world', 0, 64],
      ['normalMatrix', 64, 48],
    ]);
    expect(block('object').size).toBe(112);
  });

  it('lays out the material uniforms sorted by name', () => {
    expect(offsets('material')).toEqual([
      ['scale', 0, 4],
      ['tint', 16, 12],
    ]);
    expect(block('material').size).toBe(32);
  });

  it('only describes uniform blocks with a block layout', () => {
    expect(
      group('material')
        .bindings.slice(1)
        .map((binding) => binding.block)
    ).toEqual([undefined, undefined]);
  });
});
