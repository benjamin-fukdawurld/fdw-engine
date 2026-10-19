import { describe, expect, it } from 'vitest';
import { GraphError } from '../graph/Diagnostic';
import { defineFunction } from '../graph/functions';
import { GraphBuilder, PortHandle } from '../graph/GraphBuilder';
import { std, stdLights, stdLoops } from '../std';
import { BuiltinTypes } from '../types/ShaderType';
import { compile } from './compile';
import type { IrEntryPoint, IrInstruction } from './ir';

const stage = (
  graph: ReturnType<GraphBuilder['build']>,
  name: 'vertex' | 'fragment' = 'fragment',
) =>
  compile(graph).module.entryPoints.find(
    (entryPoint) => entryPoint.stage === name,
  ) as IrEntryPoint;

const folds = (body: readonly IrInstruction[]) =>
  body.filter((instruction) => instruction.op.kind === 'loop-fold');

// The sum of the first `count` terms of 1, 1/2, 1/4…: a vec2 state (sum,
// term).
function halves(g: GraphBuilder, count: PortHandle | number) {
  return g
    .fold([0, 1], count, (state) =>
      g.call(std.vec2, {
        x: g.call(std.add, { a: state.swizzle('x'), b: state.swizzle('y') }),
        y: g.call(std.mul, { a: state.swizzle('y'), b: 0.5 }),
      }),
    )
    .swizzle('x');
}

describe('fold loops', () => {
  it('loops over a uniform count, the state carried from an iteration to the next', () => {
    const g = new GraphBuilder('halves');
    const sum = halves(g, g.uniform('terms', BuiltinTypes.u32));
    g.surface({ baseColor: g.call(std.vec3, { x: sum }) });
    const fragment = stage(g.build());
    const [loop] = folds(fragment.body);
    const op = loop?.op;
    if (op?.kind !== 'loop-fold') {
      throw new Error('expected a fold');
    }
    expect(loop.type).toEqual(BuiltinTypes.vec2f);
    // The count is read before the loop, the initial state is a constant.
    const [count, initial] = loop.args.map((id) =>
      fragment.body.find((i) => i.id === id),
    );
    expect(count?.op).toMatchObject({ kind: 'load-resource', member: 'terms' });
    expect(initial?.op).toEqual({ kind: 'constant', value: [0, 1] });
    // The body reads the state, and gives the next one.
    expect(
      op.body.some((i) => i.op.kind === 'swizzle' && i.args.includes(op.state)),
    ).toBe(true);
    expect(op.body.find((i) => i.id === op.result)?.op.kind).toBe('construct');
  });

  it('computes what does not depend on the state once, before the loop', () => {
    const g = new GraphBuilder('hoisted');
    const scale = g.call(std.mul, {
      a: g.uniform('scale', BuiltinTypes.f32),
      b: g.uniform('gain', BuiltinTypes.f32),
    });
    const sum = g.fold(0, 4, (state, index) =>
      g.call(std.add, {
        a: state,
        b: g.call(std.mul, {
          a: scale,
          b: g.call(
            std.convert,
            { value: index },
            { params: { to: BuiltinTypes.f32 } },
          ),
        }),
      }),
    );
    g.surface({ baseColor: g.call(std.vec3, { x: sum }) });
    const fragment = stage(g.build());
    const [loop] = folds(fragment.body);
    const op = loop?.op;
    if (op?.kind !== 'loop-fold') {
      throw new Error('expected a fold');
    }
    const product = fragment.body.find(
      (i) => i.op.kind === 'binary' && i.op.operator === '*',
    );
    expect(product).toBeDefined();
    expect(op.body.some((i) => i.args.includes(product?.id ?? -1))).toBe(true);
    expect(op.body.some((i) => i.op.kind === 'load-resource')).toBe(false);
    // The index is converted in the body.
    expect(
      op.body.some((i) => i.op.kind === 'convert' && i.args[0] === op.index),
    ).toBe(true);
  });

  it('runs in the vertex stage when what it computes is per vertex', () => {
    const g = new GraphBuilder('per-vertex');
    const position = g.attribute('position', BuiltinTypes.vec3f);
    const sum = g.fold(0, 3, (state) =>
      g.call(std.add, { a: state, b: position.swizzle('x') }),
    );
    g.surface({ baseColor: g.call(std.vec3, { x: sum }) });
    const graph = g.build();
    expect(folds(stage(graph, 'vertex').body)).toHaveLength(1);
    expect(folds(stage(graph, 'fragment').body)).toHaveLength(0);
  });

  it('keeps a per-vertex value of its body in the loop when the loop is per fragment', () => {
    const g = new GraphBuilder('per-fragment');
    const position = g.attribute('position', BuiltinTypes.vec3f);
    const sum = g.fold(0, 3, (state) =>
      g.call(std.add, {
        a: g.call(std.mul, { a: state, b: position.swizzle('x') }),
        b: g.call(std.dpdx, { x: position.swizzle('y') }),
      }),
    );
    g.surface({ baseColor: g.call(std.vec3, { x: sum }) });
    const graph = g.build();
    const program = compile(graph);
    const fragment = program.module.entryPoints[1];
    const [loop] = folds(fragment.body);
    expect(loop).toBeDefined();
    // The product reads the state: in the loop, not interpolated.
    const vertex = program.module.entryPoints[0];
    expect(folds(vertex.body)).toHaveLength(0);
  });

  it('nests a loop in the body of another', () => {
    const g = new GraphBuilder('nested');
    const sum = g.fold(0, 3, (outer) =>
      g.fold(outer, 2, (inner) => g.call(std.add, { a: inner, b: 1 })),
    );
    g.surface({ baseColor: g.call(std.vec3, { x: sum }) });
    const [loop] = folds(stage(g.build()).body);
    const op = loop?.op;
    if (op?.kind !== 'loop-fold') {
      throw new Error('expected a fold');
    }
    const [inner] = folds(op.body);
    expect(inner).toBeDefined();
    // The inner loop starts from the state of the outer one.
    expect(inner.args[1]).toBe(op.state);
    expect(op.result).toBe(inner.id);
  });

  it('keeps two identical loops apart', () => {
    const g = new GraphBuilder('twice');
    const a = halves(g, 3);
    const b = halves(g, 3);
    g.surface({ baseColor: g.call(std.vec3, { x: a, y: b }) });
    // Same code: merged as a whole, but each one keeps its own state.
    expect(folds(stage(g.build()).body).length).toBeGreaterThanOrEqual(1);
    const c = new GraphBuilder('different');
    const x = halves(c, 3);
    const y = halves(c, 5);
    c.surface({ baseColor: c.call(std.vec3, { x, y }) });
    const loops = folds(stage(c.build()).body);
    expect(loops).toHaveLength(2);
    const states = loops.map((loop) =>
      loop.op.kind === 'loop-fold' ? loop.op.state : -1,
    );
    expect(states[0]).not.toBe(states[1]);
  });

  it('folds over a function node with loop.fold', () => {
    const f = new GraphBuilder('step');
    const state = f.functionInput('state', BuiltinTypes.f32);
    const index = f.functionInput('index', BuiltinTypes.u32);
    const gain = f.functionInput('gain', BuiltinTypes.f32, { default: 2 });
    f.functionOutput(
      'next',
      f.call(std.add, {
        a: f.call(std.mul, { a: state, b: gain }),
        b: f.call(
          std.convert,
          { value: index },
          { params: { to: BuiltinTypes.f32 } },
        ),
      }),
    );
    const step = defineFunction(f.build(), { id: 'test.step' });

    const g = new GraphBuilder('folded');
    g.registry.register(step);
    const result = g.call(
      stdLoops.fold,
      { initial: 1, count: g.uniform('count', BuiltinTypes.u32), gain: 3 },
      { params: { body: 'test.step' } },
    );
    g.surface({ baseColor: g.call(std.vec3, { x: result }) });
    const program = compile(g.build(), { registry: g.registry });
    const [loop] = folds(program.module.entryPoints[1].body);
    expect(loop?.type).toEqual(BuiltinTypes.f32);
  });

  it('refuses a body reaching the outputs without its end', () => {
    const g = new GraphBuilder('escape');
    let escaped: PortHandle | undefined;
    const sum = g.fold(0, 3, (state) => {
      escaped = g.call(std.add, { a: state, b: 1 });
      return escaped;
    });
    g.surface({
      baseColor: g.call(std.vec3, { x: escaped as PortHandle, y: sum }),
    });
    expect(() => compile(g.build())).toThrow(GraphError);
    expect(() => compile(g.build())).toThrow(
      /without going through its loop.end/,
    );
  });

  it('refuses an initial state depending on the state', () => {
    const g = new GraphBuilder('initial');
    const state = g.call(
      'loop.state',
      {},
      { params: { type: BuiltinTypes.f32 } },
    );
    const end = g.call('loop.end', {
      initial: g.call(std.add, { a: state, b: 1 }),
      count: 2,
      next: state,
      state,
    });
    g.surface({ baseColor: g.call(std.vec3, { x: end }) });
    expect(() => compile(g.build())).toThrow(/cannot depend on its state/);
  });

  it('refuses a loop in the body of a light loop', () => {
    const g = new GraphBuilder('per light');
    const light = g.node(stdLights.current);
    const sum = g.call(stdLights.sum, {
      value: g.fold(light.diffuse, 2, (state) =>
        g.call(std.mul, { a: state, b: 0.5 }),
      ),
    });
    g.surface({ baseColor: sum });
    expect(() => compile(g.build())).toThrow(/cannot depend on light.current/);
  });
});
