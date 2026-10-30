import type {
  FunctionDefinition,
  MacroContext,
  MacroDefinition,
  NodeDefinition,
} from '../graph/NodeDefinition';
import type { ValueSource } from '../graph/MaterialGraphData';
import { BuiltinTypes } from '../types/ShaderType';
import { generic } from '../types/PortType';
import { lightMembers } from '../compiler/layout';

const float = generic('T', 'float');

/**
 * The light being summed by a {@link sum | light.sum} node: its position,
 * colors, attenuation and spot cone (see {@link lightMembers}).
 *
 * The nodes depending on it form the body of a loop over the lights of the
 * frame; they can only reach the outputs through a `light.sum`.
 *
 * @group Standard library
 */
export const current: NodeDefinition = {
  id: 'light.current',
  category: 'input',
  description: 'The light being summed by light.sum.',
  inputs: () => [],
  outputs: () =>
    Object.entries(lightMembers).map(([name, { type }]) => ({ name, type })),
  // Lights are looped over per fragment.
  stage: () => 'fragment',
};

/**
 * The sum of a value over the lights of the frame. The value is computed
 * once per light, by the nodes depending on {@link current | light.current};
 * the other nodes it depends on are computed once, outside the loop.
 *
 * Given the world `position` of the point lit, and with the
 * `lightClusters` feature (given by the renderer), only the lights that can
 * reach the point are summed: the global ones (directional, without range)
 * and those of its cluster (see lightClusterMembers). Otherwise,
 * every light of the frame.
 *
 * @example The diffuse light received by a surface
 * ```ts
 * const light = g.node(stdLights.current);
 * const diffuse = g.call(stdLights.sum, {
 *   value: g.call(std.mul, {
 *     a: light.diffuse,
 *     b: g.call(std.max, { a: g.call(std.dot, { a: normal, b: toLight }), b: 0 }),
 *   }),
 *   position,
 * });
 * ```
 *
 * @group Standard library
 */
export const sum: FunctionDefinition = {
  id: 'light.sum',
  category: 'function',
  description: 'The sum of a value over the lights of the frame.',
  implementation: { kind: 'intrinsic', op: 'light-sum' },
  params: {
    // Set by the compiler: the lights of a cluster, given by light.cluster.
    clustered: { kind: 'boolean', default: false },
  },
  inputs: (params) => [
    { name: 'value', type: float },
    { name: 'position', type: BuiltinTypes.vec3f, optional: true },
    ...(params['clustered']
      ? (['first', 'count', 'global'] as const).map((name) => ({
          name,
          type: BuiltinTypes.u32,
        }))
      : []),
  ],
  outputs: () => [{ name: 'result', type: float }],
};

/**
 * The lights of the cluster of a point (see lightClusterMembers):
 * the first element of its list in the light grid, the length of the
 * list, and the number of global lights, summed before it. Inserted by the
 * compiler before the light.sum nodes given a position, with the
 * `lightClusters` feature.
 *
 * @group Standard library
 */
export const cluster: MacroDefinition = {
  id: 'light.cluster',
  category: 'macro',
  description: 'The lights of the cluster of a point.',
  inputs: () => [{ name: 'position', type: BuiltinTypes.vec3f }],
  outputs: () =>
    (['first', 'count', 'global'] as const).map((name) => ({
      name,
      type: BuiltinTypes.u32,
    })),
  expand: (context) => {
    const add = (type: string, inputs: Record<string, unknown>, params = {}) =>
      context.add(type, params, inputs as never)();
    const engine = (value: string) => add('input.engine', {}, { value });
    const swizzle = (source: ValueSource, components: string) =>
      ({ ...source, swizzle: components }) as ValueSource;
    const point = add('std.extend', { xyz: context.input('position'), w: 1 });
    const clip = add('std.transform', {
      matrix: engine('camera.viewProjection'),
      vector: point,
    });
    const viewZ = swizzle(
      add('std.transform', { matrix: engine('camera.view'), vector: point }),
      'z',
    );
    const grid = engine('lightClusters');
    const depth = engine('lightClusterDepth');
    // The slice: floor(log2(d) × scale + bias), d the view depth.
    const slice = add('std.clamp', {
      x: add('std.floor', {
        x: add('std.add', {
          a: add('std.mul', {
            a: add('std.log2', {
              x: add('std.max', {
                a: add('std.mul', { a: viewZ, b: -1 }),
                b: 1e-6,
              }),
            }),
            b: swizzle(depth, 'x'),
          }),
          b: swizzle(depth, 'y'),
        }),
      }),
      low: 0,
      high: add('std.sub', { a: swizzle(grid, 'z'), b: 1 }),
    });
    // The tile, from the bottom left corner of the clip space.
    const ndc = add('std.div', {
      a: swizzle(clip, 'xy'),
      b: swizzle(clip, 'w'),
    });
    const tile = add('std.clamp', {
      x: add('std.floor', {
        x: add('std.mul', {
          a: add('std.add', { a: add('std.mul', { a: ndc, b: 0.5 }), b: 0.5 }),
          b: swizzle(grid, 'xy'),
        }),
      }),
      low: [0, 0],
      high: add('std.sub', { a: swizzle(grid, 'xy'), b: 1 }),
    });
    const index = add('std.add', {
      a: add('std.mul', {
        a: add('std.add', {
          a: add('std.mul', { a: slice, b: swizzle(grid, 'y') }),
          b: swizzle(tile, 'y'),
        }),
        b: swizzle(grid, 'x'),
      }),
      b: swizzle(tile, 'x'),
    });
    const u32 = (x: ValueSource) =>
      add('std.convert', { value: x }, { to: BuiltinTypes.u32 });
    const header = add('std.mul', { a: u32(index), b: 2 });
    const lightGrid = engine('lightGrid');
    return {
      first: add('std.index', { array: lightGrid, index: header }),
      count: add('std.index', {
        array: lightGrid,
        index: add('std.add', { a: header, b: 1 }),
      }),
      global: u32(swizzle(grid, 'w')),
    };
  },
};

/**
 * The visibility of the light being summed at a point: 1 where it is lit, 0
 * in its shadow, in between at the edges of the shadows (filtered). Used
 * by the lit shading models, which multiply the direct light by it.
 *
 * Only with the 'shadows' feature (given by the renderer when lights cast
 * shadows): the visibility is read from the tile of the light in the shadow
 * atlas (the light.shadowMap function). Without it, the visibility is 1 and
 * costs nothing.
 *
 * @group Standard library
 */
export const shadow: MacroDefinition = {
  id: 'light.shadow',
  category: 'macro',
  description:
    'The visibility of the light being summed (1 without the shadows feature).',
  inputs: () => [
    // World position of the point, and its normal (for the normal offset).
    { name: 'position', type: BuiltinTypes.vec3f },
    { name: 'normal', type: BuiltinTypes.vec3f },
  ],
  outputs: () => [{ name: 'visibility', type: BuiltinTypes.f32 }],
  expand: (context) => {
    const at = {
      position: context.input('position'),
      normal: context.input('normal'),
    };
    if (context.feature('rayShadows')) {
      return { visibility: rayVisibility(context, at) };
    }
    return context.feature('shadows')
      ? { visibility: context.add('light.shadowMap', {}, at)() }
      : { visibility: { value: 1 } };
  },
};

// The visibility by rays: rayShadowSamples rays (1 by default), on a
// spiral of the disk of the light (a Vogel disk) turned by a noise per
// pixel, averaged.
function rayVisibility(
  context: MacroContext,
  at: { position?: ValueSource; normal?: ValueSource },
): ValueSource {
  const samples = Math.max(
    1,
    Math.round(Number(context.feature('rayShadowSamples') ?? 1)),
  );
  if (samples === 1) {
    return context.add('light.shadowRay', {}, at)();
  }
  // Interleaved gradient noise (Jimenez 2014), in [0, 1).
  const pixel = context.add('input.builtin', { builtin: 'frag-coord' })();
  const along = context.add(
    'std.dot',
    {},
    {
      a: { ...pixel, swizzle: 'xy' } as ValueSource,
      b: [0.06711056, 0.00583715],
    },
  )();
  const noise = context.add(
    'std.fract',
    {},
    {
      x: context.add(
        'std.mul',
        {},
        { a: context.add('std.fract', {}, { x: along })(), b: 52.9829189 },
      )(),
    },
  )();
  let sum: ValueSource | undefined;
  const golden = 0.6180339887;
  for (let k = 0; k < samples; k++) {
    const turn = context.add(
      'std.fract',
      {},
      { x: context.add('std.add', {}, { a: noise, b: k * golden })() },
    )();
    const sample = context.add(
      'std.vec2',
      {},
      { x: turn, y: (k + 0.5) / samples },
    )();
    const visibility = context.add('light.shadowRay', {}, { ...at, sample })();
    sum = sum
      ? context.add('std.add', {}, { a: sum, b: visibility })()
      : visibility;
  }
  return context.add('std.mul', {}, { a: sum, b: 1 / samples })();
}

export const lightDefinitions: readonly NodeDefinition[] = [
  current,
  sum,
  cluster,
  shadow,
];
