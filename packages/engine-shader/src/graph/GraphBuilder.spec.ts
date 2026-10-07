import { describe, expect, it } from 'vitest';
import { std } from '../std';
import { BuiltinTypes } from '../types/ShaderType';
import { GraphError } from './Diagnostic';
import { GraphBuilder } from './GraphBuilder';
import type { NodeDefinition } from './NodeDefinition';
import { NodeRegistry } from './NodeRegistry';

const texturedPhong = () => {
  const g = new GraphBuilder('textured-phong');
  const uv = g.attribute('uv', BuiltinTypes.vec2f);
  const diffuse = g.texture('diffuseMap', {
    dimension: '2d',
    slot: 'material',
  });
  const smp = g.sampler('diffuseSampler', { slot: 'material' });
  const tint = g.uniform('tint', BuiltinTypes.vec4f, {
    slot: 'material',
    default: [1, 1, 1, 1],
  });
  const texel = g.call(std.textureSample, {
    texture: diffuse,
    sampler: smp,
    uv,
  });
  const color = g.call(std.mul, { a: texel, b: tint });
  g.surface({
    shadingModel: 'phong',
    baseColor: color.swizzle('rgb'),
    alpha: color.swizzle('a'),
    shininess: g.constant(BuiltinTypes.f32, 32),
  });
  return g.build();
};

const errorOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GraphError);
    return (error as GraphError).message;
  }
  throw new Error('expected a GraphError');
};

describe('GraphBuilder', () => {
  it('builds the example of the design document', () => {
    const graph = texturedPhong();
    expect(graph.nodes).toHaveLength(8);
    expect(graph.edges).toHaveLength(8);
    expect(graph.nodes.map((node) => node.type)).toEqual([
      'input.attribute',
      'input.texture',
      'input.sampler',
      'input.uniform',
      'std.textureSample',
      'std.mul',
      'const.value',
      'output.surface',
    ]);
    expect(
      graph.edges.filter((edge) => edge.swizzle).map((edge) => edge.swizzle)
    ).toEqual(['rgb', 'a']);
  });

  it('infers the output types', () => {
    const g = new GraphBuilder('inference');
    const normal = g.attribute('normal', BuiltinTypes.vec3f);
    expect(g.call(std.mul, { a: normal, b: 2 }).type).toEqual(
      BuiltinTypes.vec3f
    );
    expect(
      g.call(std.mul, { a: g.constant(BuiltinTypes.f32, 0.5), b: normal }).type
    ).toEqual(BuiltinTypes.vec3f);
    expect(g.call(std.dot, { a: normal, b: normal }).type).toEqual(
      BuiltinTypes.f32
    );
    expect(g.call(std.mix, { a: 1, b: 2, t: 0.5 }).type).toEqual(
      BuiltinTypes.f32
    );
    expect(g.call(std.extend, { xyz: normal }).type).toEqual(
      BuiltinTypes.vec4f
    );
  });

  it('composes swizzles', () => {
    const g = new GraphBuilder('swizzle');
    const color = g.attribute('color', BuiltinTypes.vec4f);
    const zx = color.swizzle('xyz').swizzle('zx');
    expect(zx.swizzleMask).toBe('zx');
    expect(zx.type).toEqual(BuiltinTypes.vec2f);
  });

  it('reports type errors at the faulty call', () => {
    const g = new GraphBuilder('errors');
    const v3 = g.attribute('normal', BuiltinTypes.vec3f);
    const v4 = g.attribute('color', BuiltinTypes.vec4f);
    expect(errorOf(() => g.call(std.mul, { a: v3, b: v4 }))).toBe(
      'error: #n3.b: std.mul: got vec4<f32>, incompatible with vec3<f32> connected to "a"'
    );
    expect(
      errorOf(() =>
        g.call(std.normalize, { x: g.constant(BuiltinTypes.f32, 1) })
      )
    ).toMatch(/does not satisfy the constraint "float-vector"/);
    expect(errorOf(() => g.call(std.add, { a: v3, b: v3, c: 1 }))).toMatch(
      /has no input "c"/
    );
    expect(errorOf(() => v3.swizzle('w'))).toMatch(/out of range/);
    expect(errorOf(() => g.constant(BuiltinTypes.vec3f, [1, 2]))).toMatch(
      /is not a valid vec3<f32>/
    );
  });

  it('does not add a node that failed', () => {
    const g = new GraphBuilder('rollback');
    const v3 = g.attribute('normal', BuiltinTypes.vec3f);
    expect(() =>
      g.call(std.dot, { a: v3, b: g.attribute('color', BuiltinTypes.vec4f) })
    ).toThrow(GraphError);
    g.surface({ baseColor: v3 });
    expect(g.build().nodes.map((node) => node.type)).toEqual([
      'input.attribute',
      'input.attribute',
      'output.surface',
    ]);
  });

  it('accepts a single output node', () => {
    const g = new GraphBuilder('outputs');
    g.surface();
    expect(errorOf(() => g.surface())).toMatch(/already has an output node/);
  });

  it('rejects call() on nodes without exactly one output', () => {
    const g = new GraphBuilder('call');
    expect(() => g.call('output.surface')).toThrow(/exactly one output/);
  });

  it('validates the whole graph on build', () => {
    expect(errorOf(() => new GraphBuilder('empty').build())).toMatch(
      /no output node/
    );
  });

  it('declares graph parameters', () => {
    const g = new GraphBuilder('features');
    g.parameter('normalMap', false, 'Use a normal map');
    g.surface();
    expect(g.build().parameters).toEqual([
      { name: 'normalMap', default: false, description: 'Use a normal map' },
    ]);
    expect(() => g.parameter('normalMap', true)).toThrow(/already declared/);
  });

  it('registers custom node types on first use', () => {
    const halve: NodeDefinition = {
      id: 'custom.halve',
      category: 'function',
      inputs: () => [{ name: 'x', type: BuiltinTypes.f32 }],
      outputs: () => [{ name: 'result', type: BuiltinTypes.f32 }],
    };
    const registry = new NodeRegistry();
    const g = new GraphBuilder('custom', registry);
    expect(g.call(halve, { x: 1 }).type).toEqual(BuiltinTypes.f32);
    expect(registry.get('custom.halve')).toBe(halve);
    expect(() => g.call({ ...halve }, { x: 1 })).toThrow(/Another node type/);
  });
});
