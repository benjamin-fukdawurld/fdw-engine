import { describe, expect, it } from 'vitest';
import { elementOf, generic } from '../types/PortType';
import { BuiltinTypes } from '../types/ShaderType';
import { isAssignable, resolveNodeTypes } from './inference';

const numeric = generic('T', 'numeric');
const binaryPorts = {
  inputs: [
    { name: 'a', type: numeric },
    { name: 'b', type: numeric },
  ],
  outputs: [{ name: 'result', type: numeric }],
};

describe('isAssignable', () => {
  it('allows equal types and scalar splat only', () => {
    expect(isAssignable(BuiltinTypes.vec3f, BuiltinTypes.vec3f)).toBe(true);
    expect(isAssignable(BuiltinTypes.f32, BuiltinTypes.vec3f)).toBe(true);
    expect(isAssignable(BuiltinTypes.i32, BuiltinTypes.vec3f)).toBe(false);
    expect(isAssignable(BuiltinTypes.vec3f, BuiltinTypes.f32)).toBe(false);
    expect(isAssignable(BuiltinTypes.vec4f, BuiltinTypes.vec3f)).toBe(false);
  });
});

describe('resolveNodeTypes', () => {
  it('binds a generic from the connected inputs', () => {
    const { types, errors } = resolveNodeTypes({
      ...binaryPorts,
      connected: { a: BuiltinTypes.vec3f, b: BuiltinTypes.vec3f },
    });
    expect(errors).toEqual([]);
    expect(types.outputs['result']).toEqual(BuiltinTypes.vec3f);
  });

  it('widens a scalar to the vector connected to the same generic', () => {
    const { types, errors } = resolveNodeTypes({
      ...binaryPorts,
      connected: { a: BuiltinTypes.f32, b: BuiltinTypes.vec4f },
    });
    expect(errors).toEqual([]);
    expect(types.inputs['a']).toEqual(BuiltinTypes.vec4f);
    expect(types.outputs['result']).toEqual(BuiltinTypes.vec4f);
  });

  it('reports incompatible types on the faulty port', () => {
    const { errors } = resolveNodeTypes({
      ...binaryPorts,
      connected: { a: BuiltinTypes.vec3f, b: BuiltinTypes.vec4f },
    });
    expect(errors).toEqual([
      expect.objectContaining({
        port: 'b',
        message: expect.stringMatching(/incompatible/),
      }),
    ]);
  });

  it('falls back on the literal defaults when nothing is connected', () => {
    const { types, errors } = resolveNodeTypes({
      ...binaryPorts,
      connected: {},
      defaults: { a: [1, 2], b: 3 },
    });
    expect(errors).toEqual([]);
    expect(types.outputs['result']).toEqual(BuiltinTypes.vec2f);
  });

  it('checks the constraint of the generic', () => {
    const { errors } = resolveNodeTypes({
      ...binaryPorts,
      connected: { a: BuiltinTypes.bool, b: BuiltinTypes.bool },
    });
    expect(errors[0].message).toMatch(
      /does not satisfy the constraint "numeric"/
    );
  });

  it('resolves element-of outputs', () => {
    const floatVector = generic('T', 'float-vector');
    const { types } = resolveNodeTypes({
      inputs: [
        { name: 'a', type: floatVector },
        { name: 'b', type: floatVector },
      ],
      outputs: [{ name: 'result', type: elementOf('T') }],
      connected: { a: BuiltinTypes.vec3f, b: BuiltinTypes.vec3f },
    });
    expect(types.outputs['result']).toEqual(BuiltinTypes.f32);
  });

  it('requires unconnected inputs without default to be connected', () => {
    const { errors } = resolveNodeTypes({
      inputs: [{ name: 'texture', type: BuiltinTypes.texture2d }],
      outputs: [],
      connected: {},
    });
    expect(errors).toEqual([
      expect.objectContaining({
        port: 'texture',
        message: expect.stringMatching(/must be connected/),
      }),
    ]);
  });

  it('accepts unconnected optional inputs', () => {
    const { errors } = resolveNodeTypes({
      inputs: [{ name: 'normal', type: BuiltinTypes.vec3f, optional: true }],
      outputs: [],
      connected: {},
    });
    expect(errors).toEqual([]);
  });

  it('checks the default values against the port type', () => {
    const { errors } = resolveNodeTypes({
      inputs: [{ name: 'color', type: BuiltinTypes.vec3f }],
      outputs: [],
      connected: {},
      defaults: { color: [1, 0] },
    });
    expect(errors[0].message).toMatch(/is not a valid vec3<f32>/);
  });

  it('reports a generic that cannot be inferred', () => {
    const { errors } = resolveNodeTypes({ ...binaryPorts, connected: {} });
    expect(errors[0].message).toMatch(/cannot infer the type of T/);
  });
});
