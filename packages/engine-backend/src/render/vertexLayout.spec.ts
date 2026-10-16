import { BuiltinTypes } from '@fdw/engine-shader';
import { describe, expect, it } from 'vitest';
import type { MeshDescription } from '../mesh';
import {
  isVertexFormatCompatible,
  matchVertexLayout,
  meshSemantics,
  vertexFormatShaderType,
} from './vertexLayout';

const mesh: MeshDescription = {
  vertexBuffers: [
    {
      stride: 24,
      stepMode: 'vertex',
      attributes: [
        { semantic: 'position', format: 'float32x3', offset: 0 },
        { semantic: 'normal', format: 'float32x3', offset: 12 },
      ],
    },
    {
      stride: 12,
      stepMode: 'vertex',
      attributes: [
        { semantic: 'uv', format: 'float32x2', offset: 0 },
        { semantic: 'color', format: 'unorm8x4', offset: 8 },
      ],
    },
  ],
  vertexCount: 3,
};

const input = (semantic: string, type = BuiltinTypes.vec3f, location = 0) => ({
  semantic,
  type,
  location,
  name: semantic,
});

describe('vertex formats', () => {
  it.each([
    ['float32x3', BuiltinTypes.vec3f],
    ['unorm8x4', BuiltinTypes.vec4f],
    ['uint32', BuiltinTypes.u32],
    ['sint16x2', BuiltinTypes.vec2i],
  ] as const)('%s is read as %j', (format, type) => {
    expect(vertexFormatShaderType(format)).toEqual(type);
  });

  it('accepts attributes with more components than the input', () => {
    expect(isVertexFormatCompatible('float32x4', BuiltinTypes.vec3f)).toBe(
      true,
    );
    expect(isVertexFormatCompatible('float32x2', BuiltinTypes.vec3f)).toBe(
      false,
    );
    expect(isVertexFormatCompatible('uint32', BuiltinTypes.f32)).toBe(false);
    expect(isVertexFormatCompatible('float32x4', BuiltinTypes.mat4f)).toBe(
      false,
    );
  });
});

describe('matchVertexLayout', () => {
  it('keeps only the attributes and buffers read by the program', () => {
    expect(
      matchVertexLayout(
        [input('position'), input('uv', BuiltinTypes.vec2f, 1)],
        mesh,
      ),
    ).toEqual([
      {
        buffer: 0,
        stride: 24,
        stepMode: 'vertex',
        attributes: [{ format: 'float32x3', offset: 0, location: 0 }],
      },
      {
        buffer: 1,
        stride: 12,
        stepMode: 'vertex',
        attributes: [{ format: 'float32x2', offset: 0, location: 1 }],
      },
    ]);
    expect(matchVertexLayout([input('normal')], mesh)).toEqual([
      {
        buffer: 0,
        stride: 24,
        stepMode: 'vertex',
        attributes: [{ format: 'float32x3', offset: 12, location: 0 }],
      },
    ]);
  });

  it('reports missing and incompatible attributes', () => {
    expect(() => matchVertexLayout([input('tangent')], mesh)).toThrow(
      'The mesh has no "tangent" attribute',
    );
    expect(() =>
      matchVertexLayout([input('uv', BuiltinTypes.vec3f)], mesh),
    ).toThrow(/float32x2, which cannot feed a vec3<f32>/);
  });

  it('lists the semantics of a mesh', () => {
    expect(meshSemantics(mesh)).toEqual(['position', 'normal', 'uv', 'color']);
  });
});
