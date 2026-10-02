import { describe, expect, it } from 'vitest';
import { T } from '../types/ShaderType';
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
    expect(swizzleType(T.vec4f, 'a')).toEqual(T.f32);
    expect(swizzleType(T.vec4f, 'rgb')).toEqual(T.vec3f);
    expect(swizzleType(T.vec2i, 'yyxx')).toEqual(T.vec4i);
  });

  it('reports out-of-range components and non-vectors', () => {
    expect(swizzleType(T.vec3f, 'w')).toMatch(/out of range/);
    expect(swizzleType(T.f32, 'x')).toMatch(/cannot swizzle/);
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
