import { describe, expect, it } from 'vitest';
import { BuiltinTypes } from '../types/ShaderType';
import { composeSwizzles, parseSwizzle, swizzleType } from './swizzle';

describe('parseSwizzle', () => {
  it('accepts xyzw and rgba component sets', () => {
    expect(parseSwizzle('zx')).toEqual([2, 0]);
    expect(parseSwizzle('rgba')).toEqual([0, 1, 2, 3]);
  });

  it('rejects mixed sets, unknown components and bad lengths', () => {
    expect(parseSwizzle('xg')).toBeUndefined();
    expect(parseSwizzle('q')).toBeUndefined();
    expect(parseSwizzle('')).toBeUndefined();
    expect(parseSwizzle('xyzwx')).toBeUndefined();
  });
});

describe('swizzleType', () => {
  it('gives a scalar for one component and a vector otherwise', () => {
    expect(swizzleType(BuiltinTypes.vec4f, 'a')).toEqual(BuiltinTypes.f32);
    expect(swizzleType(BuiltinTypes.vec4f, 'rgb')).toEqual(BuiltinTypes.vec3f);
    expect(swizzleType(BuiltinTypes.vec2i, 'yyxx')).toEqual(BuiltinTypes.vec4i);
  });

  it('reports out-of-range components and non-vectors', () => {
    expect(swizzleType(BuiltinTypes.vec3f, 'w')).toMatch(/out of range/);
    expect(swizzleType(BuiltinTypes.f32, 'x')).toMatch(/cannot swizzle/);
  });
});

describe('composeSwizzles', () => {
  it('applies the outer swizzle to the inner one', () => {
    expect(composeSwizzles('xyz', 'zx')).toBe('zx');
    expect(composeSwizzles('wzy', 'x')).toBe('w');
    expect(composeSwizzles('rgb', 'b')).toBe('z');
  });

  it('rejects an outer swizzle wider than the inner one', () => {
    expect(composeSwizzles('xy', 'z')).toBeUndefined();
  });
});
