import { describe, expect, it } from 'vitest';
import { isConstantCompatible, literalType } from './ConstantValue';
import { generic, portTypeToString, satisfiesConstraint } from './PortType';
import {
  arrayType,
  mat,
  structType,
  T,
  texture,
  typeEquals,
  typeToString,
  vec,
} from './ShaderType';

describe('typeEquals', () => {
  it('compares scalars, vectors and matrices structurally', () => {
    expect(typeEquals(T.f32, { kind: 'scalar', scalar: 'f32' })).toBe(true);
    expect(typeEquals(T.vec3f, vec(3, 'f32'))).toBe(true);
    expect(typeEquals(T.vec3f, T.vec3i)).toBe(false);
    expect(typeEquals(T.vec3f, T.vec4f)).toBe(false);
    expect(typeEquals(T.mat4f, mat(4, 4))).toBe(true);
    expect(typeEquals(T.f32, T.vec2f)).toBe(false);
  });

  it('compares arrays, structs and textures', () => {
    expect(typeEquals(arrayType(T.f32, 4), arrayType(T.f32, 4))).toBe(true);
    expect(typeEquals(arrayType(T.f32, 4), arrayType(T.f32))).toBe(false);
    const light = structType('Light', [{ name: 'color', type: T.vec3f }]);
    expect(
      typeEquals(light, structType('Light', [{ name: 'color', type: T.vec3f }]))
    ).toBe(true);
    expect(
      typeEquals(light, structType('Light', [{ name: 'color', type: T.vec4f }]))
    ).toBe(false);
    expect(typeEquals(T.texture2d, texture('2d'))).toBe(true);
    expect(typeEquals(T.texture2d, T.depthTexture2d)).toBe(false);
  });
});

describe('typeToString', () => {
  it('gives a readable representation', () => {
    expect(typeToString(T.vec3f)).toBe('vec3<f32>');
    expect(typeToString(T.mat4f)).toBe('mat4x4<f32>');
    expect(typeToString(arrayType(T.f32, 4))).toBe('array<f32, 4>');
    expect(typeToString(T.texture2d)).toBe('texture_2d<float>');
    expect(typeToString(T.comparisonSampler)).toBe('sampler_comparison');
  });
});

describe('satisfiesConstraint', () => {
  it.each([
    [T.f32, 'numeric', true],
    [T.vec3i, 'numeric', true],
    [T.bool, 'numeric', false],
    [T.mat4f, 'numeric', false],
    [T.vec3f, 'float', true],
    [T.i32, 'float', false],
    [T.vec2f, 'float-vector', true],
    [T.f32, 'float-vector', false],
    [T.vec4u, 'integer', true],
    [T.f32, 'integer', false],
    [T.texture2d, 'any', true],
  ] as const)('%j satisfies %s: %s', (type, constraint, expected) => {
    expect(satisfiesConstraint(type, constraint)).toBe(expected);
  });

  it('describes generic ports', () => {
    expect(portTypeToString(generic('T', 'float'))).toBe('T: float');
    expect(portTypeToString(generic('T'))).toBe('T');
  });
});

describe('literals', () => {
  it('infers a default type from the literal shape', () => {
    expect(literalType(1)).toEqual(T.f32);
    expect(literalType(true)).toEqual(T.bool);
    expect(literalType([1, 2, 3])).toEqual(T.vec3f);
    expect(literalType([1])).toBeUndefined();
    expect(literalType([1, 2, 3, 4, 5])).toBeUndefined();
  });

  it('checks a literal against a type, with scalar splat', () => {
    expect(isConstantCompatible(1.5, T.f32)).toBe(true);
    expect(isConstantCompatible(1.5, T.i32)).toBe(false);
    expect(isConstantCompatible(-1, T.u32)).toBe(false);
    expect(isConstantCompatible(true, T.f32)).toBe(false);
    expect(isConstantCompatible(true, T.bool)).toBe(true);
    expect(isConstantCompatible(1, T.vec3f)).toBe(true);
    expect(isConstantCompatible([1, 2, 3], T.vec3f)).toBe(true);
    expect(isConstantCompatible([1, 2], T.vec3f)).toBe(false);
    expect(isConstantCompatible(new Array(16).fill(0), T.mat4f)).toBe(true);
    expect(isConstantCompatible(1, T.mat4f)).toBe(false);
    expect(isConstantCompatible(1, T.texture2d)).toBe(false);
  });
});
