import type { ValueSource } from '../graph/MaterialGraphData';
import type {
  MacroContext,
  MacroDefinition,
  NodeDefinition,
  ParamSchema,
  PortSchema,
} from '../graph/NodeDefinition';
import { generic } from '../types/PortType';
import { BuiltinTypes, ShaderType } from '../types/ShaderType';
import { call, swizzle } from './macros';

// The fractal sums of the noises (fbm, ridged, turbulence) and the domain
// warping, as macros: the noise and the number of octaves are parameters,
// the octaves unrolled or in a fold loop. The noises of any dimension, by
// the type of the point. As in @fdw/engine-noise.

/**
 * The noises the macros can add up: value, gradient (Perlin), simplex, or
 * cellular (Worley, its distance F1).
 *
 * @group Standard library
 */
export const NoiseNames = ['value', 'perlin', 'simplex', 'worley'] as const;
/** A noise of the standard library. */
export type NoiseName = (typeof NoiseNames)[number];

/**
 * The average values the octaves fade to when they are finer than the
 * pixel, as in @fdw/engine-noise.
 */
const fadedAverages = { fbm: 0, ridged: 0.65, turbulence: 0.2 } as const;
type FractalKind = keyof typeof fadedAverages;

/** The seed offsets of the components of a domain warp. */
const warpSeeds = [1013, 2026, 3039, 4052];

const point = generic('T', 'float-vector');
const u32 = BuiltinTypes.u32;
const f32 = BuiltinTypes.f32;

const dimensionOf = (context: MacroContext): 2 | 3 | 4 => {
  const type = context.typeOf('point') as ShaderType;
  if (type.kind !== 'vector') {
    throw new Error('the point must be a vector of 2 to 4 floats');
  }
  return type.size;
};

const u32Constant = (context: MacroContext, value: number) =>
  context.add('const.value', { type: u32, value })();

// The noise of a kind at a point: its value (F1 for Worley).
const noiseAt = (
  context: MacroContext,
  kind: NoiseName,
  n: number,
  at: ValueSource,
  seed: ValueSource | undefined,
): ValueSource => context.add(`noise.${kind}${n}`, {}, { point: at, seed })();

const noiseParam: ParamSchema = {
  kind: 'string',
  default: 'perlin',
  values: NoiseNames,
};

const fractalParams: Readonly<Record<string, ParamSchema>> = {
  noise: noiseParam,
  octaves: { kind: 'number', default: 5 },
  // 'unrolled' (the default): the octaves written one after the other;
  // 'fold': in a loop, whose count can be the octaveCount input.
  loop: { kind: 'string', default: 'unrolled', values: ['unrolled', 'fold'] },
  // Fades out the octaves finer than the pixel, from the screen space
  // derivatives of the point (fragment stage only), unless a footprint
  // is given.
  filtered: { kind: 'boolean', default: false },
};

const fractalInputs: readonly PortSchema[] = [
  { name: 'point', type: point },
  { name: 'lacunarity', type: f32, default: 2 },
  { name: 'gain', type: f32, default: 0.5 },
  { name: 'seed', type: u32, default: 0 },
  // The number of octaves of a fold loop (a uniform): params.octaves
  // otherwise.
  { name: 'octaveCount', type: u32, optional: true },
  // The size of a pixel in the units of the point: the octaves finer than
  // two pixels fade out to their average.
  { name: 'footprint', type: f32, optional: true },
];

// The size of the pixel in the units of the point: the largest component
// of its fwidth. Fragment stage only.
function pixelFootprint(
  context: MacroContext,
  at: ValueSource,
  n: number,
): ValueSource {
  const width = call(context, 'std.fwidth', { x: at });
  let largest = swizzle(width, 'x');
  for (const component of 'yzw'.slice(0, n - 1)) {
    largest = call(context, 'std.max', {
      a: largest,
      b: swizzle(width, component),
    });
  }
  return largest;
}

// 1 - smoothstep(0.25, 0.5, footprint × frequency): the weight of an
// octave, 0 when its period is under two pixels.
const octaveWeight = (
  context: MacroContext,
  footprint: ValueSource,
  frequency: ValueSource | number,
) =>
  call(context, 'std.sub', {
    a: 1,
    b: call(context, 'std.smoothstep', {
      low: 0.25,
      high: 0.5,
      x: call(context, 'std.mul', { a: footprint, b: frequency }),
    }),
  });

// What an octave adds: the noise, folded for the ridged and turbulent sums,
// faded to the average by the weight.
function octaveTerm(
  context: MacroContext,
  kind: FractalKind,
  value: ValueSource,
  weight: ValueSource | undefined,
): ValueSource {
  let term = value;
  if (kind !== 'fbm') {
    const absolute = call(context, 'std.abs', { x: value });
    if (kind === 'ridged') {
      const ridge = call(context, 'std.sub', { a: 1, b: absolute });
      term = call(context, 'std.mul', { a: ridge, b: ridge });
    } else {
      term = absolute;
    }
  }
  if (!weight) {
    return term;
  }
  // term × weight + average × (1 - weight).
  const faded = call(context, 'std.mul', { a: term, b: weight });
  const average = fadedAverages[kind];
  return average === 0
    ? faded
    : call(context, 'std.add', {
        a: faded,
        b: call(context, 'std.mul', {
          a: average,
          b: call(context, 'std.sub', { a: 1, b: weight }),
        }),
      });
}

/**
 * The nodes of a fractal sum of the noise of the macro at a point, from a
 * seed: the octaves unrolled or in a fold loop.
 */
function fractalSum(
  context: MacroContext,
  kind: FractalKind,
  at: ValueSource,
  seed: ValueSource,
): ValueSource {
  const noise = context.params['noise'] as NoiseName;
  if (!NoiseNames.includes(noise)) {
    throw new Error(`unknown noise "${noise}"`);
  }
  const octaves = context.params['octaves'] as number;
  if (!Number.isInteger(octaves) || octaves < 1 || octaves > 16) {
    throw new Error(`octaves must be an integer from 1 to 16, got ${octaves}`);
  }
  const n = dimensionOf(context);
  const lacunarity = context.input('lacunarity') as ValueSource;
  const gain = context.input('gain') as ValueSource;
  const footprint =
    context.input('footprint') ??
    (context.params['filtered'] ? pixelFootprint(context, at, n) : undefined);
  const mul = (a: ValueSource | number, b: ValueSource | number) =>
    call(context, 'std.mul', { a, b });
  const add = (a: ValueSource | number, b: ValueSource | number) =>
    call(context, 'std.add', { a, b });

  if (context.params['loop'] === 'fold') {
    const state = context.add('loop.state', { type: BuiltinTypes.vec4f })();
    const index = context.add('loop.index')();
    // The state: the sum, the amplitude, the frequency, the sum of the
    // amplitudes.
    const amplitude = swizzle(state, 'y');
    const frequency = swizzle(state, 'z');
    const value = noiseAt(
      context,
      noise,
      n,
      mul(at, frequency),
      add(seed, index),
    );
    const term = octaveTerm(
      context,
      kind,
      value,
      footprint && octaveWeight(context, footprint, frequency),
    );
    const next = call(context, 'std.vec4', {
      x: add(swizzle(state, 'x'), mul(amplitude, term)),
      y: mul(amplitude, gain),
      z: mul(frequency, lacunarity),
      w: add(swizzle(state, 'w'), amplitude),
    });
    const end = context.add(
      'loop.end',
      {},
      {
        initial: [0, 1, 1, 0],
        count: context.input('octaveCount') ?? u32Constant(context, octaves),
        next,
        state,
        index,
      },
    )();
    return call(context, 'std.div', {
      a: swizzle(end, 'x'),
      b: swizzle(end, 'w'),
    });
  }
  if (context.params['loop'] !== 'unrolled') {
    throw new Error(
      `loop must be "unrolled" or "fold", got "${context.params['loop']}"`,
    );
  }
  let sum: ValueSource | undefined;
  let total: ValueSource | number = 0;
  let amplitude: ValueSource | number = 1;
  let frequency: ValueSource | number = 1;
  for (let octave = 0; octave < octaves; octave++) {
    const value = noiseAt(
      context,
      noise,
      n,
      octave === 0 ? at : mul(at, frequency),
      octave === 0 ? seed : add(seed, u32Constant(context, octave)),
    );
    const term = octaveTerm(
      context,
      kind,
      value,
      footprint && octaveWeight(context, footprint, frequency),
    );
    const scaled = octave === 0 ? term : mul(amplitude, term);
    sum = sum === undefined ? scaled : add(sum, scaled);
    total = octave === 0 ? 1 : add(total, amplitude);
    amplitude = mul(amplitude, gain);
    frequency = mul(frequency, lacunarity);
  }
  return octaves === 1
    ? (sum as ValueSource)
    : call(context, 'std.div', { a: sum, b: total });
}

const fractal = (kind: FractalKind, description: string): MacroDefinition => ({
  id: `noise.${kind}`,
  category: 'macro',
  description,
  params: fractalParams,
  inputs: () => fractalInputs,
  outputs: () => [{ name: 'value', type: f32 }],
  expand: (context) => ({
    value: fractalSum(
      context,
      kind,
      context.input('point') as ValueSource,
      context.input('seed') as ValueSource,
    ),
  }),
});

/**
 * Fractional Brownian motion, in [-1, 1]: the octaves of a noise (the
 * noise at frequencies growing by `lacunarity`, amplitudes shrinking by
 * `gain`, octave i with seed + i) added up and divided by the sum of the
 * amplitudes. Clouds, terrains, the variations of a material.
 *
 * @group Standard library
 */
export const fbm = fractal(
  'fbm',
  'Fractional Brownian motion of a noise, in [-1, 1].',
);

/**
 * The ridged sum, in [0, 1]: the octaves of (1 - |noise|)², sharp crests
 * (mountain ridges, veins of marble).
 *
 * @group Standard library
 */
export const ridged = fractal(
  'ridged',
  'The ridged sum of a noise: (1 - |noise|)² per octave, in [0, 1].',
);

/**
 * The turbulence, in [0, 1]: the octaves of |noise|, creases (flames,
 * smoke, the veins of a rock).
 *
 * @group Standard library
 */
export const turbulence = fractal(
  'turbulence',
  'The turbulence of a noise: |noise| per octave, in [0, 1].',
);

/**
 * Domain warping: the point moved by a fbm per coordinate (each with its
 * own seed), times `strength`. A noise read at the warped point swirls and
 * stretches (I. Quilez); warp twice for marbled, liquid shapes.
 *
 * @group Standard library
 */
export const warp: MacroDefinition = {
  id: 'noise.warp',
  category: 'macro',
  description: 'The point moved by a fbm per coordinate, times strength.',
  params: fractalParams,
  inputs: () => [...fractalInputs, { name: 'strength', type: f32, default: 1 }],
  outputs: () => [{ name: 'point', type: point }],
  expand: (context) => {
    const at = context.input('point') as ValueSource;
    const seed = context.input('seed') as ValueSource;
    const n = dimensionOf(context);
    const offsets = warpSeeds.slice(0, n).map((offset) =>
      fractalSum(
        context,
        'fbm',
        at,
        call(context, 'std.add', {
          a: seed,
          b: u32Constant(context, offset),
        }),
      ),
    );
    const [x, y, z, w] = offsets;
    const vector = call(context, `std.vec${n}`, { x, y, z, w });
    return {
      point: call(context, 'std.add', {
        a: at,
        b: call(context, 'std.mul', {
          a: vector,
          b: context.input('strength'),
        }),
      }),
    };
  },
};

// A noise of any dimension: the function of the dimension of the point.
const dispatch = (
  name: NoiseName,
  description: string,
  outputs: readonly PortSchema[],
  inputs: readonly PortSchema[] = [],
): MacroDefinition => ({
  id: `noise.${name}`,
  category: 'macro',
  description,
  inputs: () => [
    { name: 'point', type: point },
    { name: 'seed', type: u32, default: 0 },
    ...inputs,
  ],
  outputs: () => outputs,
  expand: (context) => {
    const values: Record<string, ValueSource | undefined> = {};
    for (const port of context.ports) {
      values[port.name] = context.input(port.name);
    }
    const node = context.add(
      `noise.${name}${dimensionOf(context)}`,
      {},
      values,
    );
    return Object.fromEntries(
      outputs.map((output) => [output.name, node(output.name)]),
    );
  },
});

/**
 * Value noise in [-1, 1], of a point of 2 to 4 dimensions
 * (noise.value2…4).
 *
 * @group Standard library
 */
export const value = dispatch(
  'value',
  'Value noise in [-1, 1] of a point of 2 to 4 dimensions.',
  [{ name: 'value', type: f32 }],
);

/**
 * Gradient noise (Perlin) in [-1, 1], of a point of 2 to 4 dimensions
 * (noise.perlin2…4).
 *
 * @group Standard library
 */
export const perlin = dispatch(
  'perlin',
  'Gradient noise (Perlin) in [-1, 1] of a point of 2 to 4 dimensions.',
  [{ name: 'value', type: f32 }],
);

/**
 * Simplex noise in [-1, 1], of a point of 2 to 4 dimensions
 * (noise.simplex2…4).
 *
 * @group Standard library
 */
export const simplex = dispatch(
  'simplex',
  'Simplex noise in [-1, 1] of a point of 2 to 4 dimensions.',
  [{ name: 'value', type: f32 }],
);

/**
 * Cellular noise (Worley, Voronoi) of a point of 2 to 4 dimensions
 * (noise.worley2…4): the distances to the two nearest feature points, the
 * identifier of the cell of the nearest and a random float for it.
 *
 * @group Standard library
 */
export const worley = dispatch(
  'worley',
  'Cellular noise (Worley) of a point of 2 to 4 dimensions.',
  [
    { name: 'f1', type: f32 },
    { name: 'f2', type: f32 },
    { name: 'id', type: u32 },
    { name: 'random', type: f32 },
  ],
  [{ name: 'jitter', type: f32, default: 1 }],
);

export const fractalDefinitions: readonly NodeDefinition[] = [
  fbm,
  ridged,
  turbulence,
  warp,
  value,
  perlin,
  simplex,
  worley,
];
