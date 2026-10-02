import { arrayOf } from '@fdw/engine-backend';
import { describe, expect, it } from 'vitest';
import { uniformArrays } from './arrays';
import { uniformLayout } from './layouts';
import { uniformPrimitives as P } from './primitives';
import { uniformSerializers } from './serializers';
import { storageStruct, uniformStructBuilder } from './structs';
import { uniformWriters } from './writers';

const offsets = (s: { fields: readonly { name: string; offset: number }[] }) =>
  s.fields.map((field) => [field.name, field.offset]);

const fixedArray = (element: 'float32' | 'vec4', length: number) =>
  arrayOf({
    layout: uniformLayout[element],
    writer: uniformWriters[element] as never,
    serializer: uniformSerializers[element],
    length,
  });

describe('uniform struct strategy (WGSL uniform address space)', () => {
  it('packs a scalar in the padding of a vec3', () => {
    const s = uniformStructBuilder([
      { name: 'a', type: P.vec3 },
      { name: 'b', type: P.float32 },
    ]);
    expect(offsets(s)).toEqual([['a', 0], ['b', 12]]);
    expect([s.size, s.alignment]).toEqual([16, 16]);
  });

  it('reports the aligned size as runtime size', () => {
    const s = uniformStructBuilder([{ name: 'a', type: P.vec3 }]);
    expect([s.size, s.runtimeSize({})]).toEqual([16, 16]);
  });

  it('aligns nested structs to 16 bytes and serializes the attributes', () => {
    const inner = uniformStructBuilder([{ name: 'x', type: P.float32 }]);
    const outer = uniformStructBuilder([
      { name: 'a', type: P.float32 },
      { name: 'inner', type: inner },
      { name: 'b', type: P.float32 },
    ]);
    expect(offsets(outer)).toEqual([['a', 0], ['inner', 16], ['b', 32]]);
    expect([outer.size, outer.alignment]).toEqual([48, 16]);
    expect(outer.serialize().replace(/\s+/g, ' ')).toBe(
      '{ a: f32, @align(16) @size(16) inner: { x: f32 }, b: f32 }'
    );
  });

  it('accepts arrays with a 16-byte stride', () => {
    const s = uniformStructBuilder([
      { name: 'a', type: P.float32 },
      { name: 'colors', type: fixedArray('vec4', 2) },
    ]);
    expect(offsets(s)).toEqual([['a', 0], ['colors', 16]]);
    expect(s.size).toBe(48);
  });

  it('rejects arrays whose stride is not a multiple of 16', () => {
    expect(() => uniformStructBuilder([{ name: 'weights', type: fixedArray('float32', 4) }])).toThrow(
      /stride of 4 bytes.*use vec4/
    );
  });

  it('rejects runtime-sized arrays', () => {
    expect(() => uniformStructBuilder([{ name: 'items', type: uniformArrays.float32 }])).toThrow(
      /not allowed in uniform structs/
    );
  });
});

describe('storage struct strategy', () => {
  it('keeps the natural alignment of nested structs', () => {
    const inner = storageStruct([{ name: 'x', type: P.float32 }]);
    const outer = storageStruct([
      { name: 'a', type: P.float32 },
      { name: 'inner', type: inner },
      { name: 'b', type: P.float32 },
    ]);
    expect(offsets(outer)).toEqual([['a', 0], ['inner', 4], ['b', 8]]);
    expect(outer.size).toBe(12);
  });

  it('accepts a runtime-sized array as last field', () => {
    const s = storageStruct([
      { name: 'count', type: P.uint32 },
      { name: 'items', type: uniformArrays.vec4 },
    ]);
    expect(s.hasDynamicSize).toBe(true);
    expect(s.runtimeSize({ count: 2, items: [{}, {}] })).toBe(48);
  });

  it('rejects a runtime-sized struct nested in another struct', () => {
    const runtime = storageStruct([{ name: 'items', type: uniformArrays.float32 }]);
    expect(() => storageStruct([{ name: 'r', type: runtime }])).toThrow(/cannot be members of other structs/);
  });

  it('rejects a runtime-sized array that is not the last field', () => {
    expect(() =>
      storageStruct([
        { name: 'items', type: uniformArrays.float32 },
        { name: 'count', type: P.uint32 },
      ])
    ).toThrow(/must be the last field/);
  });
});
