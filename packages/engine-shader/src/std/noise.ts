import { defineFunction } from '../graph/functions';
import { GraphBuilder, PortHandle } from '../graph/GraphBuilder';
import type { FunctionDefinition } from '../graph/NodeDefinition';
import { NodeRegistry } from '../graph/NodeRegistry';
import { BuiltinTypes, ShaderType, vec } from '../types/ShaderType';
import * as functions from './functions';
import { components, Ops, Value } from './ops';

// The noises of the standard library, as function graphs: integer hashes
// of the PCG family (Jarzynski and Olano 2020), the value, gradient
// (Perlin), simplex and cellular (Worley) noises, in 2, 3 and 4
// dimensions (the 4th one: time). Only 32-bit integer operations and
// floats exactly representable: the same bits on every backend. The
// package @fdw/engine-noise computes the same noises in TypeScript, in the
// same order of operations.

/** The dimensions of the noises. */
export type NoiseDimension = 2 | 3 | 4;
const dimensions: readonly NoiseDimension[] = [2, 3, 4];

const u32 = BuiltinTypes.u32;
const f32 = BuiltinTypes.f32;
const floats = (n: number) => vec(n as NoiseDimension, 'f32');
const unsigned = (n: number) => vec(n as NoiseDimension, 'u32');
const signed = (n: number) => vec(n as NoiseDimension, 'i32');
const uvec = (n: number) =>
  n === 2 ? functions.uvec2 : n === 3 ? functions.uvec3 : functions.uvec4;

/**
 * The scales of the gradient noises (√n / 2 at most, to 1) and of the
 * simplex noises (their measured largest values to 1), as in
 * @fdw/engine-noise.
 */
export const perlinScales = { 2: 2 / Math.sqrt(2), 3: 2 / Math.sqrt(3), 4: 1 };
export const simplexScales = { 2: 99, 3: 108, 4: 109 } as const;

const skews = {
  2: { f: (Math.sqrt(3) - 1) / 2, g: (3 - Math.sqrt(3)) / 6, r2: 0.5 },
  3: { f: 1 / 3, g: 1 / 6, r2: 0.5 },
  4: { f: (Math.sqrt(5) - 1) / 4, g: (5 - Math.sqrt(5)) / 20, r2: 0.5 },
} as const;

/**
 * The noise functions of the standard library, built on a registry with
 * the base node types (they call each other: each one is registered once
 * built).
 */
export function createNoiseFunctions(base: NodeRegistry): FunctionDefinition[] {
  const registry = new NodeRegistry(base.definitions);
  const definitions: FunctionDefinition[] = [];
  const define = (
    id: string,
    description: string,
    build: (f: GraphBuilder, o: Ops) => void,
  ) => {
    const f = new GraphBuilder(id, registry);
    build(f, new Ops(f));
    const definition = defineFunction(f.build(), { id, description, registry });
    registry.register(definition);
    definitions.push(definition);
  };

  // --- Hashes ----------------------------------------------------------------

  define(
    'noise.pcg',
    'A pseudo-random u32 from a u32: the PCG hash (RXS-M-XS).',
    (f, o) => {
      const value = f.functionInput('value', u32);
      const state = o.add(o.mul(value, 747796405), 2891336453);
      const word = o.mul(
        o.xor(o.shr(state, o.add(o.shr(state, 28), 4)), state),
        277803737,
      );
      f.functionOutput('result', o.xor(o.shr(word, 22), word));
    },
  );

  // v = v × 1664525 + 1013904223, component-wise: the start of pcg2d…4d.
  const lcg = (o: Ops, v: PortHandle) => o.add(o.mul(v, 1664525), 1013904223);
  // x ^ (x >> 16).
  const xorShift = (o: Ops, v: PortHandle) => o.xor(v, o.shr(v, 16));

  define(
    'noise.pcg2d',
    'Two pseudo-random u32 from two u32 (pcg2d).',
    (f, o) => {
      const v = lcg(o, f.functionInput('value', unsigned(2)));
      const mixRound = (w: PortHandle) => {
        const x = o.add(w.swizzle('x'), o.mul(w.swizzle('y'), 1664525));
        const y = o.add(w.swizzle('y'), o.mul(x, 1664525));
        return xorShift(o, f.call(functions.uvec2, { x, y }));
      };
      f.functionOutput('result', mixRound(mixRound(v)));
    },
  );

  // The mixing of pcg3d and pcg4d: each component plus the product of two
  // others, in order.
  const mixComponents = (
    o: Ops,
    v: PortHandle,
    pairs: readonly (readonly [number, number])[],
  ): PortHandle => {
    const c: Value[] = components(pairs.length).map((name) => v.swizzle(name));
    pairs.forEach(([a, b], k) => {
      c[k] = o.add(c[k], o.mul(c[a], c[b]));
    });
    return o.f.call(
      uvec(pairs.length),
      Object.fromEntries(
        components(pairs.length).map((name, k) => [name, c[k]]),
      ),
    );
  };
  const pcgPairs = {
    3: [
      [1, 2],
      [2, 0],
      [0, 1],
    ],
    4: [
      [1, 3],
      [2, 0],
      [0, 1],
      [1, 2],
    ],
  } as const;
  for (const n of [3, 4] as const) {
    define(
      `noise.pcg${n}d`,
      `${n === 3 ? 'Three' : 'Four'} pseudo-random u32 from ${n} u32 (pcg${n}d).`,
      (f, o) => {
        let v = lcg(o, f.functionInput('value', unsigned(n)));
        v = mixComponents(o, v, pcgPairs[n]);
        v = xorShift(o, v);
        f.functionOutput('result', mixComponents(o, v, pcgPairs[n]));
      },
    );
  }

  for (const n of dimensions) {
    define(
      `noise.hash${n}`,
      `${n} pseudo-random u32 for the integer cell of a point (its floor), for a seed (hashed, then mixed into every coordinate).`,
      (f, o) => {
        const cell = f.functionInput('cell', floats(n));
        const seed = f.functionInput('seed', u32, { default: 0 });
        const bits = o.convert(
          o.convert(o.floor(cell), signed(n)),
          unsigned(n),
        );
        const key = o.xor(bits, f.call('noise.pcg', { value: seed }));
        f.functionOutput('hash', f.call(`noise.pcg${n}d`, { value: key }));
      },
    );
  }

  // u32 to [0, 1): the 24 high bits, exact in a f32.
  const toUnit = (o: Ops, hash: PortHandle, n: number) =>
    o.mul(o.convert(o.shr(hash, 8), n === 1 ? f32 : floats(n)), 1 / 16777216);

  for (const n of dimensions) {
    define(
      `noise.random${n}`,
      `${n} random floats in [0, 1) for the integer cell of a point: one value per tile, brick, cell.`,
      (f, o) => {
        const point = f.functionInput('point', floats(n));
        const seed = f.functionInput('seed', u32, { default: 0 });
        const hash = f.call(`noise.hash${n}`, { cell: point, seed });
        f.functionOutput('value', toUnit(o, hash, n));
      },
    );
  }

  // --- Lattice noises --------------------------------------------------------

  // The lattice of a point: its cell, its position in it, the fade.
  const lattice = (o: Ops, point: PortHandle) => {
    const cell = o.floor(point);
    const t = o.sub(point, cell);
    // t³ (t (6 t - 15) + 10).
    const fade = o.mul(
      o.mul(o.mul(t, t), t),
      o.add(o.mul(t, o.sub(o.mul(t, 6), 15)), 10),
    );
    return { cell, t, fade };
  };
  // The offset of corner c (bit k for coordinate k).
  const cornerOffset = (c: number, n: number) =>
    Array.from({ length: n }, (_, k) => (c >> k) & 1);
  // Interpolates 2^n corner values along x, then y, z, w.
  const interpolate = (
    o: Ops,
    values: Value[],
    fade: PortHandle,
    n: number,
  ) => {
    let current = values;
    for (const name of components(n)) {
      const next: Value[] = [];
      for (let i = 0; i < current.length; i += 2) {
        next.push(o.mix(current[i], current[i + 1], fade.swizzle(name)));
      }
      current = next;
    }
    return current[0];
  };
  // A random unit vector from a hash: [-1, 1) per component, normalized.
  const gradient = (o: Ops, hash: PortHandle, n: number) => {
    const g = o.sub(o.mul(toUnit(o, hash, n), 2), 1);
    return o.div(g, o.sqrt(o.max(o.dot(g, g), 1e-12)));
  };

  for (const n of dimensions) {
    define(
      `noise.value${n}`,
      `Value noise in [-1, 1], ${n}D: a random value at each integer point, interpolated by the quintic fade.`,
      (f, o) => {
        const point = f.functionInput('point', floats(n));
        const seed = f.functionInput('seed', u32, { default: 0 });
        const { cell, fade } = lattice(o, point);
        const values = Array.from({ length: 1 << n }, (_, c) => {
          const hash = f.call(`noise.hash${n}`, {
            cell: o.add(cell, cornerOffset(c, n)),
            seed,
          });
          return o.sub(o.mul(toUnit(o, hash.swizzle('x'), 1), 2), 1);
        });
        f.functionOutput('value', interpolate(o, values, fade, n));
      },
    );
  }

  for (const n of dimensions) {
    define(
      `noise.perlin${n}`,
      `Gradient noise (Perlin) in [-1, 1], ${n}D: a random unit gradient at each integer point, interpolated by the quintic fade.`,
      (f, o) => {
        const point = f.functionInput('point', floats(n));
        const seed = f.functionInput('seed', u32, { default: 0 });
        const { cell, t, fade } = lattice(o, point);
        const values = Array.from({ length: 1 << n }, (_, c) => {
          const offset = cornerOffset(c, n);
          const hash = f.call(`noise.hash${n}`, {
            cell: o.add(cell, offset),
            seed,
          });
          return o.dot(gradient(o, hash, n), o.sub(t, offset));
        });
        f.functionOutput(
          'value',
          o.mul(interpolate(o, values, fade, n), perlinScales[n]),
        );
      },
    );
  }

  // The corners of the simplex of x0 after the first one, by the rank of
  // its coordinates (Gustavson, McEwan).
  const simplexCorners = (o: Ops, x0: PortHandle, n: number): PortHandle[] => {
    const c = (mask: string) => x0.swizzle(mask);
    if (n === 2) {
      const x = o.step(c('y'), c('x'));
      return [o.vec2(x, o.sub(1, x))];
    }
    if (n === 3) {
      const g = o.step(c('yzx'), c('xyz'));
      const l = o.sub(1, g);
      return [o.min(g, l.swizzle('zxy')), o.max(g, l.swizzle('zxy'))];
    }
    const isX = o.step(c('yzw'), c('xxx'));
    const isYZ = o.step(c('zww'), c('yyz'));
    const not = (v: PortHandle) => o.sub(1, v);
    const rank = o.vec4(
      o.add(o.add(isX.swizzle('x'), isX.swizzle('y')), isX.swizzle('z')),
      o.add(o.add(not(isX.swizzle('x')), isYZ.swizzle('x')), isYZ.swizzle('y')),
      o.add(
        o.add(not(isX.swizzle('y')), not(isYZ.swizzle('x'))),
        isYZ.swizzle('z'),
      ),
      o.add(
        o.add(not(isX.swizzle('z')), not(isYZ.swizzle('y'))),
        not(isYZ.swizzle('z')),
      ),
    );
    return [
      o.clamp(o.sub(rank, 2), 0, 1),
      o.clamp(o.sub(rank, 1), 0, 1),
      o.clamp(rank, 0, 1),
    ];
  };

  for (const n of dimensions) {
    define(
      `noise.simplex${n}`,
      `Simplex noise in [-1, 1], ${n}D: the gradients of the corners of the simplex of the point, each fading out with the distance.`,
      (f, o) => {
        const point = f.functionInput('point', floats(n));
        const seed = f.functionInput('seed', u32, { default: 0 });
        const { f: skew, g: unskew, r2 } = skews[n];
        const sum = (v: PortHandle) => o.dot(v, new Array(n).fill(1));
        const base = o.floor(o.add(point, o.mul(sum(point), skew)));
        const x0 = o.add(o.sub(point, base), o.mul(sum(base), unskew));
        const offsets: Value[] = [
          new Array(n).fill(0),
          ...simplexCorners(o, x0, n),
          new Array(n).fill(1),
        ];
        let total: Value = 0;
        offsets.forEach((offset, c) => {
          const x = c === 0 ? x0 : o.add(o.sub(x0, offset), c * unskew);
          const a = o.max(o.sub(r2, o.dot(x, x)), 0);
          const a2 = o.mul(a, a);
          const hash = f.call(`noise.hash${n}`, {
            cell: c === 0 ? base : o.add(base, offset),
            seed,
          });
          const term = o.mul(o.mul(a2, a2), o.dot(gradient(o, hash, n), x));
          total = c === 0 ? term : o.add(total, term);
        });
        f.functionOutput('value', o.mul(total, simplexScales[n]));
      },
    );
  }

  // --- Cellular noise --------------------------------------------------------

  const worleyOutputs = (
    f: GraphBuilder,
    o: Ops,
    best: { d1: Value; d2: Value; hash: Value },
  ) => {
    const id = f.call('noise.pcg', { value: best.hash });
    f.functionOutput('f1', o.sqrt(best.d1));
    f.functionOutput('f2', o.sqrt(best.d2));
    f.functionOutput('id', id);
    f.functionOutput('random', toUnit(o, id, 1));
  };
  // The squared distance from the position in the cell to the feature
  // point of a neighbor cell, and the hash of that cell.
  const featureDistance = (
    f: GraphBuilder,
    o: Ops,
    n: number,
    {
      cell,
      position,
      offset,
      seed,
      jitter,
    }: {
      cell: PortHandle;
      position: PortHandle;
      offset: Value;
      seed: PortHandle;
      jitter: PortHandle;
    },
  ) => {
    const hash = f.call(`noise.hash${n}`, { cell: o.add(cell, offset), seed });
    const feature = o.add(
      o.add(offset, 0.5),
      o.mul(jitter, o.sub(toUnit(o, hash, n), 0.5)),
    );
    const d = o.sub(feature, position);
    return { squared: o.dot(d, d), hash: hash.swizzle('x') };
  };
  // Keeps the two nearest distances and the hash of the nearest cell.
  const keepNearest = (
    o: Ops,
    best: { d1: Value; d2: Value; hash: Value },
    candidate: { squared: Value; hash: Value },
  ) => {
    const closer = o.less(candidate.squared, best.d1);
    return {
      d2: o.select(o.min(best.d2, candidate.squared), best.d1, closer),
      d1: o.select(best.d1, candidate.squared, closer),
      hash: o.select(best.hash, candidate.hash, closer),
    };
  };
  const worleyDescription = (n: number) =>
    `Cellular noise (Worley), ${n}D: a feature point per integer cell (jitter 1: anywhere in it, 0: at its center); f1 and f2, the distances to the nearest feature points; id and random, the identifier of the cell of the nearest (Voronoi) and a random float in [0, 1) for it.`;

  for (const n of [2, 3] as const) {
    define(`noise.worley${n}`, worleyDescription(n), (f, o) => {
      const point = f.functionInput('point', floats(n));
      const seed = f.functionInput('seed', u32, { default: 0 });
      const jitter = f.functionInput('jitter', f32, { default: 1 });
      const cell = o.floor(point);
      const position = o.sub(point, cell);
      let best: { d1: Value; d2: Value; hash: Value } = {
        d1: 1e10,
        d2: 1e10,
        hash: o.u32(0),
      };
      // The 3^n neighbor cells, x varying the fastest.
      for (let i = 0; i < 3 ** n; i++) {
        const offset = Array.from(
          { length: n },
          (_, k) => (Math.floor(i / 3 ** k) % 3) - 1,
        );
        best = keepNearest(
          o,
          best,
          featureDistance(f, o, n, { cell, position, offset, seed, jitter }),
        );
      }
      worleyOutputs(f, o, best);
    });
  }

  // In 4D, the 81 cells in a fold loop: the state keeps the two squared
  // distances and the index of the nearest cell, whose hash is computed
  // again after the loop.
  define('noise.worley4', worleyDescription(4), (f, o) => {
    const point = f.functionInput('point', floats(4));
    const seed = f.functionInput('seed', u32, { default: 0 });
    const jitter = f.functionInput('jitter', f32, { default: 1 });
    const cell = o.floor(point);
    const position = o.sub(point, cell);
    // The offset of the neighbor of an index: its digits in base 3, - 1.
    const offsetOf = (index: PortHandle) =>
      o.sub(
        o.convert(
          f.call(functions.uvec4, {
            x: o.remainder(index, 3),
            y: o.remainder(f.call(functions.div, { a: index, b: o.u32(3) }), 3),
            z: o.remainder(f.call(functions.div, { a: index, b: o.u32(9) }), 3),
            w: f.call(functions.div, { a: index, b: o.u32(27) }),
          }),
          floats(4),
        ),
        1,
      );
    const best = f.fold([1e10, 1e10, 0, 0], 81, (state, index) => {
      const candidate = featureDistance(f, o, 4, {
        cell,
        position,
        offset: offsetOf(index),
        seed,
        jitter,
      });
      const closer = o.less(candidate.squared, state.swizzle('x'));
      return o.vec4(
        o.select(state.swizzle('x'), candidate.squared, closer),
        o.select(
          o.min(state.swizzle('y'), candidate.squared),
          state.swizzle('x'),
          closer,
        ),
        o.select(state.swizzle('z'), o.convert(index, f32), closer),
        0,
      );
    });
    const nearest = offsetOf(o.convert(best.swizzle('z'), u32));
    const hash = f
      .call('noise.hash4', { cell: o.add(cell, nearest), seed })
      .swizzle('x');
    worleyOutputs(f, o, {
      d1: best.swizzle('x'),
      d2: best.swizzle('y'),
      hash,
    });
  });

  return definitions;
}

/** The type of a point of n dimensions. */
export const noisePointType = (n: NoiseDimension): ShaderType => floats(n);
