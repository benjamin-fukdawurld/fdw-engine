import { describe, expect, it } from 'vitest';
import type { GpuStructFieldBluePrint, StructBuildStrategy } from './GpuStruct';
import type { GpuType } from './GpuType';
import { StructBuilder, struct } from './structs';

const align = (offset: number, alignment: number) =>
  Math.ceil(offset / alignment) * alignment;

// A minimal strategy with natural alignment, to test the builder alone.
const naturalStrategy: StructBuildStrategy = {
  align,
  hasDynamicSize: () => undefined,
  validateFields: () => undefined,
  getFieldSize: (field) => ('size' in field.type ? field.type.size : 0),
  getFieldAlignment: (field) =>
    'alignment' in field.type ? field.type.alignment : 1,
  getFieldOffset: ({ offset, alignment }) => align(offset, alignment),
  getRuntimeSizeCallback: (blueprint: GpuStructFieldBluePrint) => () =>
    blueprint.size,
  getWriteCallback: () => () => undefined,
  getSerializeCallback: (blueprint: GpuStructFieldBluePrint) => () =>
    blueprint.fields.map((field) => field.name).join(','),
};

const primitive = (size: number, alignment: number): GpuType<number> => ({
  size,
  alignment,
  write: () => undefined,
  serialize: () => `p${size}`,
});

const f32 = primitive(4, 4);
const vec3 = primitive(12, 16);

describe('StructBuilder', () => {
  it('lays out fields with their alignment and rounds the size', () => {
    const s = struct(naturalStrategy, [
      { name: 'a', type: vec3 },
      { name: 'b', type: f32 },
      { name: 'c', type: vec3 },
    ]);
    expect(s.fields.map((field) => field.offset)).toEqual([0, 12, 16]);
    expect(s.alignment).toBe(16);
    expect(s.size).toBe(32);
    expect(s.stride).toBe(32);
    expect(s.runtimeSize({})).toBe(32);
  });

  it('builds structs that are not affected by later changes to the builder', () => {
    const builder = new StructBuilder(naturalStrategy).withField({
      name: 'a',
      type: f32,
    });
    const built = builder.build();
    builder.withField({ name: 'b', type: vec3 });

    expect(built.fields).toHaveLength(1);
    expect(built.size).toBe(4);
    expect(built.serialize()).toBe('a');
    expect(builder.build().fields).toHaveLength(2);
  });
});
