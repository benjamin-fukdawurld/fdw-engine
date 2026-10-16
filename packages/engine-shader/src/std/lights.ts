import type {
  FunctionDefinition,
  MacroDefinition,
  NodeDefinition,
} from '../graph/NodeDefinition';
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
 * @example The diffuse light received by a surface
 * ```ts
 * const light = g.node(stdLights.current);
 * const diffuse = g.call(stdLights.sum, {
 *   value: g.call(std.mul, {
 *     a: light.diffuse,
 *     b: g.call(std.max, { a: g.call(std.dot, { a: normal, b: toLight }), b: 0 }),
 *   }),
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
  inputs: () => [{ name: 'value', type: float }],
  outputs: () => [{ name: 'result', type: float }],
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
  expand: (context) =>
    context.feature('shadows')
      ? {
          visibility: context.add(
            'light.shadowMap',
            {},
            {
              position: context.input('position'),
              normal: context.input('normal'),
            },
          )(),
        }
      : { visibility: { value: 1 } },
};

export const lightDefinitions: readonly NodeDefinition[] = [
  current,
  sum,
  shadow,
];
