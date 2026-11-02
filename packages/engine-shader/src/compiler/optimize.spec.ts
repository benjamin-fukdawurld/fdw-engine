import { describe, expect, it } from 'vitest';
import { GraphBuilder } from '../graph/GraphBuilder';
import type { GraphNode } from '../graph/MaterialGraphData';
import { validateGraph } from '../graph/validateGraph';
import { createStandardRegistry, std } from '../std';
import { arrayType, BuiltinTypes } from '../types/ShaderType';
import { eliminateDeadCode, optimize, structuralParams } from './optimize';
import { WorkingGraph } from './WorkingGraph';

const registry = createStandardRegistry();

// A compute graph writing `value` to output[0]: the write is the root that
// keeps the value alive.
const writing = (
  build: (g: GraphBuilder) => Parameters<GraphBuilder['write']>[1]['value'],
) => {
  const g = new GraphBuilder('optimize', registry);
  const output = g.storage('output', arrayType(BuiltinTypes.f32), {
    access: 'read-write',
  });
  g.write(output, { index: 0, value: build(g) });
  g.compute();
  return g.build();
};

const optimized = (graph: ReturnType<typeof writing>) => {
  const working = new WorkingGraph(graph);
  const validation = validateGraph(working.toData(), registry);
  expect(validation.valid).toBe(true);
  optimize(working, registry, validation.order, validation.types);
  return working;
};

// The node feeding the value of the write.
const writtenNode = (working: WorkingGraph): GraphNode => {
  const write = [...working.nodes.values()].find(
    (node) => node.type === 'write.storage',
  ) as GraphNode;
  const source = working.inputSource(write, 'value');
  if (!source || !('ref' in source)) {
    throw new Error('the value is not connected');
  }
  return working.nodes.get(source.ref.node) as GraphNode;
};

const types = (working: WorkingGraph) =>
  [...working.nodes.values()].map((node) => node.type).sort();

describe('optimize', () => {
  it('removes the nodes that reach no root', () => {
    const graph = writing((g) => {
      g.call(std.add, { a: g.uniform('unused', BuiltinTypes.f32), b: 1 });
      return g.uniform('used', BuiltinTypes.f32);
    });
    const working = new WorkingGraph(graph);
    eliminateDeadCode(working);
    const names = [...working.nodes.values()]
      .filter((node) => node.type === 'input.uniform')
      .map((node) => node.params['name']);
    expect(names).toEqual(['used']);
    expect(types(working)).not.toContain('std.add');
  });

  it('folds the constant arithmetic', () => {
    const working = optimized(
      writing((g) =>
        g.call(std.mul, { a: g.call(std.add, { a: 2, b: 3 }), b: 0.5 }),
      ),
    );
    const node = writtenNode(working);
    expect(node.type).toBe('const.value');
    expect(node.params['value']).toBe(2.5);
    // The intermediate sum is dead once folded.
    expect(types(working)).toEqual([
      'const.value',
      'input.storage',
      'output.compute',
      'write.storage',
    ]);
  });

  it('folds vectors through swizzles, rounded to f32', () => {
    const working = optimized(
      writing((g) => {
        const v = g.constant(BuiltinTypes.vec3f, [0.1, 2, 3]);
        return g.call(std.dot, { a: v, b: v.swizzle('xxx') });
      }),
    );
    const node = writtenNode(working);
    expect(node.type).toBe('const.value');
    expect(node.params['value']).toBe(Math.fround(0.1 * 0.1 + 0.2 + 0.3));
  });

  it('leaves the non finite results to the GPU', () => {
    const working = optimized(writing((g) => g.call(std.div, { a: 1, b: 0 })));
    expect(writtenNode(working).type).toBe('std.div');
  });

  it('does not fold the values that are not constant', () => {
    const working = optimized(
      writing((g) =>
        g.call(std.add, { a: g.uniform('offset', BuiltinTypes.f32), b: 1 }),
      ),
    );
    expect(writtenNode(working).type).toBe('std.add');
  });

  it('merges the nodes computing the same value', () => {
    const working = optimized(
      writing((g) => {
        // The default value of a uniform is not part of the program.
        const a = g.uniform('scale', BuiltinTypes.f32, { default: 1 });
        const b = g.uniform('scale', BuiltinTypes.f32, { default: 2 });
        return g.call(std.add, {
          a: g.call(std.mul, { a, b: 2 }),
          b: g.call(std.mul, { a: b, b: 2 }),
        });
      }),
    );
    expect(types(working).filter((type) => type === 'std.mul')).toHaveLength(1);
    expect(
      types(working).filter((type) => type === 'input.uniform'),
    ).toHaveLength(1);
    const sum = writtenNode(working);
    const [a, b] = ['a', 'b'].map((port) => working.inputSource(sum, port));
    expect(a).toEqual(b);
  });

  it('keeps the nodes that differ by their inputs', () => {
    const working = optimized(
      writing((g) => {
        const scale = g.uniform('scale', BuiltinTypes.f32);
        return g.call(std.add, {
          a: g.call(std.mul, { a: scale, b: 2 }),
          b: g.call(std.mul, { a: scale, b: 3 }),
        });
      }),
    );
    expect(types(working).filter((type) => type === 'std.mul')).toHaveLength(2);
  });
});

describe('structuralParams', () => {
  it('ignores the default value of the uniforms only', () => {
    expect(
      structuralParams({
        id: 'n0',
        type: 'input.uniform',
        params: { name: 'tint', default: [1, 1, 1, 1] },
      }),
    ).toEqual({ name: 'tint' });
    const params = { type: BuiltinTypes.f32, value: 1 };
    expect(structuralParams({ id: 'n0', type: 'const.value', params })).toBe(
      params,
    );
  });
});
