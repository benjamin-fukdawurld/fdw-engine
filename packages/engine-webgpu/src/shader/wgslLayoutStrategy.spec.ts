import type { UniformValue } from '@fdw/engine-backend';
import {
  arrayType,
  compile,
  GraphBuilder,
  ShaderType,
  std,
  BuiltinTypes,
} from '@fdw/engine-shader';
import { describe, expect, it } from 'vitest';
import { wgslLayoutStrategy } from './wgslLayoutStrategy';

const program = () => {
  const g = new GraphBuilder('layout');
  const uv = g.attribute('uv', BuiltinTypes.vec2f);
  const texel = g.call(std.textureSample, {
    texture: g.texture('diffuseMap'),
    sampler: g.sampler('diffuseSampler'),
    uv,
  });
  const scale = g.uniform('scale', BuiltinTypes.f32);
  const tint = g.uniform('tint', BuiltinTypes.vec3f);
  const color = g.call(std.mul, {
    a: g.call(std.mul, { a: texel.swizzle('rgb'), b: tint }),
    b: scale,
  });
  g.surface({
    baseColor: color,
    alpha: g.call(
      std.convert,
      { value: g.uniform('mode', BuiltinTypes.u32, { slot: 'pass' }) },
      { params: { to: BuiltinTypes.f32 } }
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
      ['exposure', 208, 4],
      ['lightCount', 212, 4],
      // Arrays of 16 vec4, aligned to 16 bytes.
      ['lightPositions', 224, 256],
      ['lightAmbients', 480, 256],
      ['lightDiffuses', 736, 256],
      ['lightSpeculars', 992, 256],
      ['lightAttenuations', 1248, 256],
      ['lightSpotDirections', 1504, 256],
      ['lightSpotCones', 1760, 256],
      ['lightShadows', 2016, 256],
      ['lightShadowRects', 2272, 256],
      // Arrays of 16 mat4.
      ['lightShadowMatrices', 2528, 1024],
    ]);
    expect(block('frame').size).toBe(3552);
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

describe('wgslLayoutStrategy.writeUniform', () => {
  const write = (type: ShaderType, value: UniformValue, size = 64) => {
    const view = new DataView(new ArrayBuffer(size));
    wgslLayoutStrategy.writeUniform(
      view,
      { name: 'u', type, offset: 0, size },
      value
    );
    return view;
  };
  const floats = (view: DataView) => [...new Float32Array(view.buffer)];

  it('writes scalars with their kind', () => {
    expect(write(BuiltinTypes.f32, 1.5).getFloat32(0, true)).toBe(1.5);
    expect(write(BuiltinTypes.i32, -3).getInt32(0, true)).toBe(-3);
    expect(write(BuiltinTypes.u32, 7).getUint32(0, true)).toBe(7);
    expect(write(BuiltinTypes.u32, true).getUint32(0, true)).toBe(1);
  });

  it('writes vectors', () => {
    expect(floats(write(BuiltinTypes.vec3f, [1, 2, 3], 16))).toEqual([
      1, 2, 3, 0,
    ]);
  });

  it('pads the columns of a mat3, from packed or padded data', () => {
    const expected = [1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0];
    expect(
      floats(write(BuiltinTypes.mat3f, [1, 2, 3, 4, 5, 6, 7, 8, 9], 48))
    ).toEqual(expected);
    expect(
      floats(
        write(BuiltinTypes.mat3f, [1, 2, 3, 99, 4, 5, 6, 99, 7, 8, 9, 99], 48)
      )
    ).toEqual(expected);
  });

  it('writes the elements of an array at their stride', () => {
    const type = arrayType(BuiltinTypes.vec3f, 3);
    // Two elements given out of three: the last one stays zero.
    expect(floats(write(type, [1, 2, 3, 4, 5, 6], 48))).toEqual([
      1, 2, 3, 0, 4, 5, 6, 0, 0, 0, 0, 0,
    ]);
  });

  it('gives the stride of the elements of storage arrays', () => {
    const strides = [
      BuiltinTypes.f32,
      BuiltinTypes.vec2f,
      BuiltinTypes.vec3f,
      BuiltinTypes.vec4f,
      BuiltinTypes.mat3f,
    ].map((element) => {
      const resolved = wgslLayoutStrategy.resolve({
        groups: [
          {
            slot: 'material',
            bindings: [
              {
                kind: 'storage-buffer',
                name: 'values',
                type: arrayType(element),
                access: 'read',
              },
            ],
          },
        ],
      });
      return resolved.groups[0].bindings[0].storage?.elementStride;
    });
    // Unlike uniform arrays, scalars and vec2 are not rounded up to 16.
    expect(strides).toEqual([4, 8, 16, 16, 48]);
  });

  it('rejects arrays whose stride is not a multiple of 16', () => {
    expect(() =>
      wgslLayoutStrategy.resolve({
        groups: [
          {
            slot: 'material',
            bindings: [
              {
                kind: 'uniform-block',
                name: 'materialUniforms',
                members: [
                  { name: 'weights', type: arrayType(BuiltinTypes.f32, 4) },
                ],
              },
            ],
          },
        ],
      })
    ).toThrow(/multiple of 16/);
  });

  it('writes a mat4 as is', () => {
    const matrix = Array.from({ length: 16 }, (_, i) => i);
    expect(floats(write(BuiltinTypes.mat4f, matrix, 64))).toEqual(matrix);
  });

  it('rejects values of the wrong shape', () => {
    expect(() => write(BuiltinTypes.vec3f, [1, 2])).toThrow(
      /expects 3 components/
    );
    expect(() => write(BuiltinTypes.f32, [1])).toThrow(/expects a number/);
  });
});
