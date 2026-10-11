import { BuiltinTypes, ShaderType } from '@fdw/engine-shader';
import { describe, expect, it } from 'vitest';
import { objectRowLayout, std140LayoutStrategy } from './std140LayoutStrategy';

const block = (members: { name: string; type: ShaderType }[]) => {
  const layout = std140LayoutStrategy.resolve({
    groups: [
      {
        slot: 'material',
        bindings: [
          { kind: 'uniform-block', name: 'materialUniforms', members },
        ],
      },
    ],
  });
  const result = layout.groups[0].bindings[0].block;
  if (!result) {
    throw new Error('expected a uniform block');
  }
  return result;
};

describe('std140LayoutStrategy', () => {
  it('packs a scalar after a vec3', () => {
    const { size, members } = block([
      { name: 'position', type: BuiltinTypes.vec3f },
      { name: 'time', type: BuiltinTypes.f32 },
      { name: 'uv', type: BuiltinTypes.vec2f },
      { name: 'color', type: BuiltinTypes.vec4f },
    ]);
    expect(members.map((member) => member.offset)).toEqual([0, 12, 16, 32]);
    expect(size).toBe(48);
  });

  it('aligns every matrix column to 16 bytes, mat2 included', () => {
    const { size, members } = block([
      { name: 'a', type: BuiltinTypes.f32 },
      { name: 'normalMatrix', type: BuiltinTypes.mat3f },
      {
        name: 'rotation',
        type: { kind: 'matrix', columns: 2, rows: 2, scalar: 'f32' },
      },
      { name: 'b', type: BuiltinTypes.f32 },
    ]);
    expect(members.map((member) => [member.offset, member.size])).toEqual([
      [0, 4],
      [16, 48],
      [64, 32],
      [96, 4],
    ]);
    // Rounded up to the alignment of a vec4.
    expect(size).toBe(112);
  });

  it('writes matrices with padded columns', () => {
    const { members, size } = block([
      {
        name: 'rotation',
        type: { kind: 'matrix', columns: 2, rows: 2, scalar: 'f32' },
      },
      { name: 'normalMatrix', type: BuiltinTypes.mat3f },
    ]);
    const data = new DataView(new ArrayBuffer(size));
    std140LayoutStrategy.writeUniform(data, members[0], [1, 2, 3, 4]);
    std140LayoutStrategy.writeUniform(
      data,
      members[1],
      [1, 2, 3, 4, 5, 6, 7, 8, 9]
    );
    const floats = new Float32Array(data.buffer);
    expect([...floats.subarray(0, 8)]).toEqual([1, 2, 0, 0, 3, 4, 0, 0]);
    expect([...floats.subarray(8, 20)]).toEqual([
      1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0,
    ]);
  });

  it('reads a wgpu-matrix mat3 (12 floats, padded columns)', () => {
    const { members, size } = block([
      { name: 'normalMatrix', type: BuiltinTypes.mat3f },
    ]);
    const data = new DataView(new ArrayBuffer(size));
    // The padding of the source is not a component: 99 must not be read.
    std140LayoutStrategy.writeUniform(
      data,
      members[0],
      [1, 2, 3, 99, 4, 5, 6, 99, 7, 8, 9, 99]
    );
    expect([...new Float32Array(data.buffer)]).toEqual([
      1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0,
    ]);
  });

  it('writes integers and booleans as 32-bit values', () => {
    const { members, size } = block([
      { name: 'count', type: BuiltinTypes.i32 },
      { name: 'enabled', type: BuiltinTypes.bool },
    ]);
    const data = new DataView(new ArrayBuffer(size));
    std140LayoutStrategy.writeUniform(data, members[0], -3);
    std140LayoutStrategy.writeUniform(data, members[1], true);
    expect(data.getInt32(0, true)).toBe(-3);
    expect(data.getUint32(4, true)).toBe(1);
  });
});

describe('objectRowLayout', () => {
  it('lays a row out as the object uniform block: 112 bytes', () => {
    const row = objectRowLayout([
      { name: 'world', type: BuiltinTypes.mat4f },
      { name: 'normalMatrix', type: BuiltinTypes.mat3f },
    ]);
    expect(row.size).toBe(112);
    expect(
      row.members.map(({ name, offset, size }) => [name, offset, size])
    ).toEqual([
      ['world', 0, 64],
      ['normalMatrix', 64, 48],
    ]);
  });
});
