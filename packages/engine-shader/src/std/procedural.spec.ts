import { describe, expect, it } from 'vitest';
import { compile } from '../compiler/compile';
import {
  forEachInstruction,
  IrEntryPoint,
  IrInstruction,
} from '../compiler/ir';
import { defineFunction } from '../graph/functions';
import { GraphBuilder, PortHandle } from '../graph/GraphBuilder';
import { BuiltinTypes } from '../types/ShaderType';
import { std, stdMapping, stdNoise, stdPatterns } from './index';

const attributes = { vertexAttributes: ['position', 'normal', 'uv'] };

const stages = (graph: ReturnType<GraphBuilder['build']>) => {
  const [vertex, fragment] = compile(graph, attributes).module
    .entryPoints as IrEntryPoint[];
  return { vertex, fragment };
};

const all = (body: readonly IrInstruction[]) => {
  const instructions: IrInstruction[] = [];
  forEachInstruction(body, (instruction) => instructions.push(instruction));
  return instructions;
};

const gray = (g: GraphBuilder, value: PortHandle) =>
  g.surface({ baseColor: g.call(std.vec3, { x: value, y: value, z: value }) });

describe('noises', () => {
  for (const n of [2, 3, 4] as const) {
    for (const noise of ['value', 'perlin', 'simplex', 'worley']) {
      it(`compiles noise.${noise}${n}, per fragment from the world position`, () => {
        const g = new GraphBuilder(`${noise}${n}`);
        const position = g.call(stdMapping.worldPosition);
        const point =
          n === 2
            ? position.swizzle('xz')
            : n === 3
              ? position
              : g.call(std.extend, { xyz: position, w: g.engine('time') });
        const outputs = g.node(stdNoise[noise as 'perlin'], {
          inputs: { point },
        });
        gray(g, Object.values(outputs)[0]);
        const { vertex, fragment } = stages(g.build());
        const operators = all(fragment.body).flatMap((i) =>
          i.op.kind === 'binary' ? [i.op.operator] : [],
        );
        // The hash: integer products, xor and shifts, in the fragment
        // stage; nothing of it in the vertex stage.
        expect(operators).toContain('^');
        expect(operators).toContain('>>');
        expect(
          all(vertex.body).some(
            (i) => i.op.kind === 'binary' && i.op.operator === '^',
          ),
        ).toBe(false);
      });
    }
  }

  it('loops over the 81 cells of the 4D cellular noise', () => {
    const g = new GraphBuilder('worley4');
    const cells = g.node('noise.worley4', {
      inputs: {
        point: g.call(std.extend, {
          xyz: g.call(stdMapping.objectPosition),
          w: g.engine('time'),
        }),
      },
    });
    gray(g, cells.f1);
    const folds = all(stages(g.build()).fragment.body).filter(
      (i) => i.op.kind === 'loop-fold',
    );
    expect(folds).toHaveLength(1);
  });

  it('types the integer literals given to the noise functions', () => {
    // A seed of 3: a u32 through the inlined functions, not a float.
    const g = new GraphBuilder('seeded');
    gray(
      g,
      g.call('noise.perlin2', {
        point: g.call(stdMapping.worldPosition).swizzle('xz'),
        seed: 3,
      }),
    );
    const constants = all(stages(g.build()).fragment.body).filter(
      (i) => i.op.kind === 'constant' && i.op.value === 3,
    );
    expect(constants.map((i) => i.type)).toContainEqual(BuiltinTypes.u32);
  });
});

describe('fractal sums', () => {
  const fbm = (
    params: Record<string, string | number | boolean>,
    uniform = false,
  ) => {
    const g = new GraphBuilder('fbm');
    const point = g.call(stdMapping.worldPosition);
    gray(
      g,
      g.call(
        stdNoise.fbm,
        {
          point,
          ...(uniform
            ? { octaveCount: g.uniform('octaves', BuiltinTypes.u32) }
            : {}),
        },
        { params },
      ),
    );
    return all(stages(g.build()).fragment.body);
  };

  it('unrolls the octaves, or loops over them', () => {
    const unrolled = fbm({ octaves: 4 });
    expect(unrolled.some((i) => i.op.kind === 'loop-fold')).toBe(false);
    // One hash of the seed per octave (seed + i).
    const folded = fbm({ octaves: 4, loop: 'fold' }, true);
    expect(folded.filter((i) => i.op.kind === 'loop-fold')).toHaveLength(1);
    expect(folded.length).toBeLessThan(unrolled.length / 2);
  });

  it('fades the fine octaves by the derivatives of the point, per fragment only', () => {
    expect(
      fbm({ octaves: 3, filtered: true }).some(
        (i) => i.op.kind === 'intrinsic' && i.op.name === 'fwidth',
      ),
    ).toBe(true);
    const g = new GraphBuilder('vertex fbm');
    const position = g.attribute('position', BuiltinTypes.vec3f);
    const height = g.call(
      stdNoise.fbm,
      { point: position },
      { params: { filtered: true } },
    );
    g.surface({
      positionOffset: g.call(std.mul, { a: [0, 1, 0], b: height }),
    });
    expect(() => compile(g.build(), attributes)).toThrow(/fragment stage/);
  });

  it('warps a point by a fbm per coordinate, and nests the cellular loop in the octaves', () => {
    const g = new GraphBuilder('warp');
    const point = g.call(stdMapping.worldPosition).swizzle('xy');
    const warped = g.call(
      stdNoise.warp,
      { point, strength: 2 },
      { params: { octaves: 2 } },
    );
    expect(warped.type).toEqual(BuiltinTypes.vec2f);
    const cells = g.call(
      stdNoise.ridged,
      {
        point: g.call(std.extend, {
          xyz: g.call(stdMapping.worldPosition),
          w: 1,
        }),
      },
      { params: { noise: 'worley', octaves: 2, loop: 'fold' } },
    );
    gray(g, g.call(std.add, { a: warped.swizzle('x'), b: cells }));
    const folds = stages(g.build()).fragment.body.filter(
      (i) => i.op.kind === 'loop-fold',
    );
    // The loop of the octaves, the loop of the cells in its body.
    expect(folds).toHaveLength(1);
    const outer = folds[0].op;
    expect(
      outer.kind === 'loop-fold' &&
        outer.body.some((i) => i.op.kind === 'loop-fold'),
    ).toBe(true);
  });

  it('refuses an unknown noise and too many octaves', () => {
    const g = new GraphBuilder('wrong');
    gray(
      g,
      g.call(
        stdNoise.fbm,
        { point: g.call(stdMapping.worldPosition) },
        { params: { octaves: 40 } },
      ),
    );
    expect(() => compile(g.build(), attributes)).toThrow(/octaves/);
  });
});

describe('patterns and mapping', () => {
  it('gives the mask, the cell, the position and the edge of the bricks', () => {
    const g = new GraphBuilder('bricks');
    const uv = g.call(std.perFragment, {
      value: g.attribute('uv', BuiltinTypes.vec2f),
    });
    const bricks = g.node(stdPatterns.bricks, { inputs: { uv } });
    expect(Object.keys(bricks)).toEqual(['mask', 'local', 'cell', 'edge']);
    const color = g.call('noise.random2', { point: bricks.cell });
    g.surface({
      baseColor: g.call(std.mul, { a: color.swizzle('xxy'), b: bricks.mask }),
    });
    expect(() => compile(g.build(), attributes)).not.toThrow();
  });

  it('filters the checkerboard and the stripes in the fragment stage only', () => {
    const g = new GraphBuilder('vertex checker');
    const uv = g.attribute('uv', BuiltinTypes.vec2f);
    g.surface({
      positionOffset: g.call(std.mul, {
        a: [0, 1, 0],
        b: g.call(stdPatterns.checkerFiltered, { uv }),
      }),
    });
    expect(() => compile(g.build(), attributes)).toThrow(/fragment stage/);
    const f = new GraphBuilder('stripes');
    gray(
      f,
      f.call(stdPatterns.stripesFiltered, {
        x: f.call(stdMapping.objectPosition).swizzle('x'),
      }),
    );
    expect(() => compile(f.build(), attributes)).not.toThrow();
  });

  it('maps a function on the three planes of the axes, blended by the normal', () => {
    const f = new GraphBuilder('ridges');
    const uv = f.functionInput('uv', BuiltinTypes.vec2f);
    const width = f.functionInput('width', BuiltinTypes.f32, { default: 0.5 });
    f.functionOutput(
      'value',
      f.call(stdPatterns.stripes, {
        x: f.call(std.add, { a: uv.swizzle('x'), b: uv.swizzle('y') }),
        width,
      }),
    );
    const ridges = defineFunction(f.build(), { id: 'test.ridges' });

    const g = new GraphBuilder('triplanar');
    g.registry.register(ridges);
    const value = g.call(
      stdMapping.triplanar,
      { scale: 4, width: 0.3 },
      { params: { body: 'test.ridges' } },
    );
    expect(value.type).toEqual(BuiltinTypes.f32);
    gray(g, value);
    const program = compile(g.build(), { ...attributes, registry: g.registry });
    // Three planes: three steps of the stripes, and the weights' powers.
    const fragment = all(program.module.entryPoints[1].body);
    expect(
      fragment.filter((i) => i.op.kind === 'intrinsic' && i.op.name === 'step'),
    ).toHaveLength(3);
    expect(
      fragment.some((i) => i.op.kind === 'intrinsic' && i.op.name === 'pow'),
    ).toBe(true);
  });

  it('reads a texture on the three planes', () => {
    const g = new GraphBuilder('triplanar texture');
    const color = g.call(stdMapping.triplanarTexture, {
      texture: g.texture('rock'),
      sampler: g.sampler('rockSampler'),
      scale: 0.5,
    });
    g.surface({ baseColor: color.swizzle('rgb') });
    const fragment = all(stages(g.build()).fragment.body);
    expect(fragment.filter((i) => i.op.kind === 'sample')).toHaveLength(3);
  });
});
