import { describe, expect, it } from 'vitest';
import { GraphBuilder } from '../graph/GraphBuilder';
import { std } from '../std';
import { arrayType, BuiltinTypes, ShaderType } from '../types/ShaderType';
import { compile } from './compile';
import type { IrEntryPoint } from './ir';

// The last color of a palette read from a storage buffer.
const paletteGraph = (
  type: ShaderType = arrayType(BuiltinTypes.vec4f),
  access?: 'read' | 'read-write'
) => {
  const g = new GraphBuilder('palette');
  const palette = g.storage('palette', type, access ? { access } : {});
  const last = g.call(std.sub, {
    a: g.call(std.arrayLength, { array: palette }),
    b: 1,
  });
  g.surface({
    baseColor: g
      .call(std.index, { array: palette, index: last })
      .swizzle('rgb'),
  });
  return g.build();
};

describe('storage buffers', () => {
  it('declares a storage buffer binding in the slot of the node', () => {
    const program = compile(paletteGraph());
    const material = program.layout.groups.find(
      (group) => group.slot === 'material'
    );
    expect(material?.bindings).toEqual([
      {
        kind: 'storage-buffer',
        name: 'palette',
        type: arrayType(BuiltinTypes.vec4f),
        access: 'read',
      },
    ]);
  });

  it('reads the elements and the length of the array', () => {
    const fragment = compile(paletteGraph()).module.entryPoints.find(
      (entryPoint) => entryPoint.stage === 'fragment'
    ) as IrEntryPoint;
    const kinds = fragment.body.map((instruction) => instruction.op.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(['load-resource', 'array-length', 'index'])
    );
    const element = fragment.body.find((i) => i.op.kind === 'index');
    expect(element?.type).toEqual(BuiltinTypes.vec4f);
    const length = fragment.body.find((i) => i.op.kind === 'array-length');
    expect(length?.type).toEqual(BuiltinTypes.u32);
  });

  it('types std.index with the element of the array', () => {
    const g = new GraphBuilder('index');
    const values = g.storage('values', arrayType(BuiltinTypes.mat3f));
    expect(
      g.call(std.index, {
        array: values,
        index: g.uniform('i', BuiltinTypes.u32),
      }).type
    ).toEqual(BuiltinTypes.mat3f);
    // The index is an integer.
    expect(() =>
      g.call(std.index, {
        array: values,
        index: g.uniform('f', BuiltinTypes.f32),
      })
    ).toThrow(/integer/);
    // Only arrays are indexed.
    expect(() =>
      g.call(std.index, {
        array: g.uniform('v', BuiltinTypes.vec4f),
        index: g.uniform('j', BuiltinTypes.u32),
      })
    ).toThrow(/array/);
  });

  it('rejects storage buffers that are not runtime-sized numeric arrays', () => {
    expect(() =>
      compile(paletteGraph(arrayType(BuiltinTypes.vec4f, 4)))
    ).toThrow(/must be a runtime-sized array/);
    // Checked even when the buffer is not read.
    const g = new GraphBuilder('flags');
    g.storage('flags', arrayType(BuiltinTypes.bool));
    g.surface({ baseColor: [1, 0, 0] });
    expect(() => compile(g.build())).toThrow(/must be a runtime-sized array/);
  });

  it('only reads storage buffers for now', () => {
    expect(() =>
      compile(paletteGraph(arrayType(BuiltinTypes.vec4f), 'read-write'))
    ).toThrow(/only read access is supported/);
  });

  it('rejects storage buffers on backends without them', () => {
    expect(() =>
      compile(paletteGraph(), { capabilities: { storageBuffers: false } })
    ).toThrow(/the backend has no storage buffers/);
  });
});
