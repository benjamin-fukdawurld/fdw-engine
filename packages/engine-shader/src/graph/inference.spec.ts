import { describe, expect, it } from 'vitest';
import { elementOf, generic } from '../types/PortType';
import { T } from '../types/ShaderType';
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
    expect(isAssignable(T.vec3f, T.vec3f)).toBe(true);
    expect(isAssignable(T.f32, T.vec3f)).toBe(true);
    expect(isAssignable(T.i32, T.vec3f)).toBe(false);
    expect(isAssignable(T.vec3f, T.f32)).toBe(false);
    expect(isAssignable(T.vec4f, T.vec3f)).toBe(false);
  });
});

describe('resolveNodeTypes', () => {
  it('binds a generic from the connected inputs', () => {
    const { types, errors } = resolveNodeTypes({
      ...binaryPorts,
      connected: { a: T.vec3f, b: T.vec3f },
    });
    expect(errors).toEqual([]);
    expect(types.outputs['result']).toEqual(T.vec3f);
  });

  it('widens a scalar to the vector connected to the same generic', () => {
    const { types, errors } = resolveNodeTypes({
      ...binaryPorts,
      connected: { a: T.f32, b: T.vec4f },
    });
    expect(errors).toEqual([]);
    expect(types.inputs['a']).toEqual(T.vec4f);
    expect(types.outputs['result']).toEqual(T.vec4f);
  });

  it('reports incompatible types on the faulty port', () => {
    const { errors } = resolveNodeTypes({
      ...binaryPorts,
      connected: { a: T.vec3f, b: T.vec4f },
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
    expect(types.outputs['result']).toEqual(T.vec2f);
  });

  it('checks the constraint of the generic', () => {
    const { errors } = resolveNodeTypes({
      ...binaryPorts,
      connected: { a: T.bool, b: T.bool },
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
      connected: { a: T.vec3f, b: T.vec3f },
    });
    expect(types.outputs['result']).toEqual(T.f32);
  });

  it('requires unconnected inputs without default to be connected', () => {
    const { errors } = resolveNodeTypes({
      inputs: [{ name: 'texture', type: T.texture2d }],
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
      inputs: [{ name: 'normal', type: T.vec3f, optional: true }],
      outputs: [],
      connected: {},
    });
    expect(errors).toEqual([]);
  });

  it('checks the default values against the port type', () => {
    const { errors } = resolveNodeTypes({
      inputs: [{ name: 'color', type: T.vec3f }],
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
