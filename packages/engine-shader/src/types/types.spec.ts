import { describe, expect, it } from 'vitest';
import { isConstantCompatible, literalType } from './ConstantValue';
import { generic, portTypeToString, satisfiesConstraint } from './PortType';
import {
  arrayType,
  mat,
  structType,
  BuiltinTypes,
  texture,
  typeEquals,
  typeToString,
  vec,
} from './ShaderType';

describe('typeEquals', () => {
  it('compares scalars, vectors and matrices structurally', () => {
    expect(
      typeEquals(BuiltinTypes.f32, { kind: 'scalar', scalar: 'f32' }),
    ).toBe(true);
    expect(typeEquals(BuiltinTypes.vec3f, vec(3, 'f32'))).toBe(true);
    expect(typeEquals(BuiltinTypes.vec3f, BuiltinTypes.vec3i)).toBe(false);
    expect(typeEquals(BuiltinTypes.vec3f, BuiltinTypes.vec4f)).toBe(false);
    expect(typeEquals(BuiltinTypes.mat4f, mat(4, 4))).toBe(true);
    expect(typeEquals(BuiltinTypes.f32, BuiltinTypes.vec2f)).toBe(false);
  });

  it('compares arrays, structs and textures', () => {
    expect(
      typeEquals(
        arrayType(BuiltinTypes.f32, 4),
        arrayType(BuiltinTypes.f32, 4),
      ),
    ).toBe(true);
    expect(
      typeEquals(arrayType(BuiltinTypes.f32, 4), arrayType(BuiltinTypes.f32)),
    ).toBe(false);
    const light = structType('Light', [
      { name: 'color', type: BuiltinTypes.vec3f },
    ]);
    expect(
      typeEquals(
        light,
        structType('Light', [{ name: 'color', type: BuiltinTypes.vec3f }]),
      ),
    ).toBe(true);
    expect(
      typeEquals(
        light,
        structType('Light', [{ name: 'color', type: BuiltinTypes.vec4f }]),
      ),
    ).toBe(false);
    expect(typeEquals(BuiltinTypes.texture2d, texture('2d'))).toBe(true);
    expect(
      typeEquals(BuiltinTypes.texture2d, BuiltinTypes.depthTexture2d),
    ).toBe(false);
  });
});

describe('typeToString', () => {
  it('gives a readable representation', () => {
    expect(typeToString(BuiltinTypes.vec3f)).toBe('vec3<f32>');
    expect(typeToString(BuiltinTypes.mat4f)).toBe('mat4x4<f32>');
    expect(typeToString(arrayType(BuiltinTypes.f32, 4))).toBe('array<f32, 4>');
    expect(typeToString(BuiltinTypes.texture2d)).toBe('texture_2d<float>');
    expect(typeToString(BuiltinTypes.comparisonSampler)).toBe(
      'sampler_comparison',
    );
  });
});

describe('satisfiesConstraint', () => {
  it.each([
    [BuiltinTypes.f32, 'numeric', true],
    [BuiltinTypes.vec3i, 'numeric', true],
    [BuiltinTypes.bool, 'numeric', false],
    [BuiltinTypes.mat4f, 'numeric', false],
    [BuiltinTypes.vec3f, 'float', true],
    [BuiltinTypes.i32, 'float', false],
    [BuiltinTypes.vec2f, 'float-vector', true],
    [BuiltinTypes.f32, 'float-vector', false],
    [BuiltinTypes.vec4u, 'integer', true],
    [BuiltinTypes.f32, 'integer', false],
    [BuiltinTypes.texture2d, 'any', true],
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
    expect(literalType(1)).toEqual(BuiltinTypes.f32);
    expect(literalType(true)).toEqual(BuiltinTypes.bool);
    expect(literalType([1, 2, 3])).toEqual(BuiltinTypes.vec3f);
    expect(literalType([1])).toBeUndefined();
    expect(literalType([1, 2, 3, 4, 5])).toBeUndefined();
  });

  it('checks a literal against a type, with scalar splat', () => {
    expect(isConstantCompatible(1.5, BuiltinTypes.f32)).toBe(true);
    expect(isConstantCompatible(1.5, BuiltinTypes.i32)).toBe(false);
    expect(isConstantCompatible(-1, BuiltinTypes.u32)).toBe(false);
    expect(isConstantCompatible(true, BuiltinTypes.f32)).toBe(false);
    expect(isConstantCompatible(true, BuiltinTypes.bool)).toBe(true);
    expect(isConstantCompatible(1, BuiltinTypes.vec3f)).toBe(true);
    expect(isConstantCompatible([1, 2, 3], BuiltinTypes.vec3f)).toBe(true);
    expect(isConstantCompatible([1, 2], BuiltinTypes.vec3f)).toBe(false);
    expect(
      isConstantCompatible(new Array(16).fill(0), BuiltinTypes.mat4f),
    ).toBe(true);
    expect(isConstantCompatible(1, BuiltinTypes.mat4f)).toBe(false);
    expect(isConstantCompatible(1, BuiltinTypes.texture2d)).toBe(false);
  });
});
