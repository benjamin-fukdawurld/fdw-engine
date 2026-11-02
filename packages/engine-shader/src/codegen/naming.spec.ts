import { describe, expect, it } from 'vitest';
import { BuiltinTypes } from '../types/ShaderType';
import type { IrInstruction } from '../compiler/ir';
import {
  memberIdentifier,
  resourceIdentifier,
  sanitizeIdentifier,
  structName,
  valueName,
} from './naming';

describe('naming', () => {
  it('sanitizes identifiers', () => {
    expect(sanitizeIdentifier('base color')).toBe('base_color');
    expect(sanitizeIdentifier('_x')).toBe('x');
    expect(sanitizeIdentifier('a-_b')).toBe('a_b');
    expect(sanitizeIdentifier('albedo')).toBe('albedo');
  });

  it('prefixes the names chosen by the user', () => {
    expect(memberIdentifier('tint')).toBe('u_tint');
    expect(
      resourceIdentifier({
        kind: 'texture',
        name: 'diffuseMap',
      } as Parameters<typeof resourceIdentifier>[0]),
    ).toBe('t_diffuseMap');
    expect(structName('materialUniforms')).toBe('MaterialUniforms');
  });

  it('names the values of the instructions', () => {
    const instruction = (name?: string) =>
      ({
        id: 7,
        name,
        type: BuiltinTypes.f32,
        args: [],
      }) as unknown as IrInstruction;
    expect(valueName(instruction())).toBe('v7');
    expect(valueName(instruction('my color'))).toBe('v7_my_color');
  });
});
