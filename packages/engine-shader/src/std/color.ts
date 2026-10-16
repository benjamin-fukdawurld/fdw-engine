import { defineFunction } from '../graph/functions';
import { GraphBuilder } from '../graph/GraphBuilder';
import type { FunctionDefinition } from '../graph/NodeDefinition';
import type { NodeRegistry } from '../graph/NodeRegistry';
import { BuiltinTypes } from '../types/ShaderType';
import * as functions from './functions';

/**
 * The tone mapping operators, compressing linear colors from [0, ∞) to
 * [0, 1]:
 * - `none`: clamped, for tests and technical renderings;
 * - `reinhard`: simple, desaturates the bright areas;
 * - `aces`: filmic, contrasted (fit of the ACES curve by K. Narkowicz);
 * - `neutral`: Khronos PBR Neutral, keeps the colors of the materials.
 *
 * @group Standard library
 */
export const ToneMappingNames = [
  'none',
  'reinhard',
  'aces',
  'neutral',
] as const;
/**
 * A tone mapping operator.
 *
 * @group Standard library
 */
export type ToneMapping = (typeof ToneMappingNames)[number];

const vec3 = BuiltinTypes.vec3f;
const { add, sub, mul, div, min, max, mix, pow, step, saturate, select } =
  functions;

// A function vec3 → vec3 of the standard library.
function colorFunction(
  registry: NodeRegistry,
  id: string,
  description: string,
  body: (
    f: GraphBuilder,
    color: ReturnType<GraphBuilder['functionInput']>,
  ) => ReturnType<GraphBuilder['call']>,
): FunctionDefinition {
  const f = new GraphBuilder(id, registry);
  const color = f.functionInput('color', vec3);
  f.functionOutput('result', body(f, color));
  return defineFunction(f.build(), { id, description, registry });
}

/**
 * The color functions of the standard library, built with the given
 * registry: linear to sRGB encoding and the tone mapping operators.
 */
export function createColorFunctions(
  registry: NodeRegistry,
): FunctionDefinition[] {
  return [
    // c ≤ 0.0031308 ? 12.92 c : 1.055 c^(1/2.4) - 0.055, per component.
    colorFunction(
      registry,
      'color.linearToSrgb',
      'Encodes a linear color in sRGB, for display; clamped to [0, 1].',
      (f, color) => {
        const c = f.call(saturate, { x: color });
        const low = f.call(mul, { a: c, b: 12.92 });
        const high = f.call(sub, {
          a: f.call(mul, {
            a: f.call(pow, { base: c, exponent: 1 / 2.4 }),
            b: 1.055,
          }),
          b: 0.055,
        });
        return f.call(mix, {
          a: low,
          b: high,
          t: f.call(step, { edge: 0.0031308, x: c }),
        });
      },
    ),
    colorFunction(
      registry,
      'color.toneMapReinhard',
      'Reinhard tone mapping: c / (1 + c).',
      (f, color) =>
        f.call(div, { a: color, b: f.call(add, { a: color, b: 1 }) }),
    ),
    colorFunction(
      registry,
      'color.toneMapAces',
      'Filmic tone mapping: fit of the ACES curve by K. Narkowicz.',
      (f, color) =>
        f.call(saturate, {
          x: f.call(div, {
            a: f.call(mul, {
              a: color,
              b: f.call(add, {
                a: f.call(mul, { a: color, b: 2.51 }),
                b: 0.03,
              }),
            }),
            b: f.call(add, {
              a: f.call(mul, {
                a: color,
                b: f.call(add, {
                  a: f.call(mul, { a: color, b: 2.43 }),
                  b: 0.59,
                }),
              }),
              b: 0.14,
            }),
          }),
        }),
    ),
    // Khronos PBR Neutral: colors below the start of the compression are
    // kept (up to a small offset of the darkest component); above it, the
    // peak is compressed towards 1 and slightly desaturated.
    colorFunction(
      registry,
      'color.toneMapNeutral',
      'Khronos PBR Neutral tone mapping: keeps the colors of the materials.',
      (f, color) => {
        const startCompression = 0.8 - 0.04;
        const desaturation = 0.15;
        const x = f.call(min, {
          a: color.swizzle('x'),
          b: f.call(min, { a: color.swizzle('y'), b: color.swizzle('z') }),
        });
        const offset = f.call(select, {
          ifFalse: 0.04,
          ifTrue: f.call(sub, {
            a: x,
            b: f.call(mul, { a: f.call(mul, { a: x, b: x }), b: 6.25 }),
          }),
          condition: f.call(functions.less, { a: x, b: 0.08 }),
        });
        const shifted = f.call(sub, { a: color, b: offset });
        const peak = f.call(max, {
          a: shifted.swizzle('x'),
          b: f.call(max, {
            a: shifted.swizzle('y'),
            b: shifted.swizzle('z'),
          }),
        });
        const d = 1 - startCompression;
        const newPeak = f.call(sub, {
          a: 1,
          b: f.call(div, {
            a: d * d,
            b: f.call(add, { a: peak, b: d - startCompression }),
          }),
        });
        const compressed = f.call(mul, {
          a: shifted,
          b: f.call(div, { a: newPeak, b: peak }),
        });
        const g = f.call(sub, {
          a: 1,
          b: f.call(div, {
            a: 1,
            b: f.call(add, {
              a: f.call(mul, {
                a: desaturation,
                b: f.call(sub, { a: peak, b: newPeak }),
              }),
              b: 1,
            }),
          }),
        });
        const desaturated = f.call(mix, {
          a: compressed,
          b: f.call(functions.vec3, { x: newPeak, y: newPeak, z: newPeak }),
          t: g,
        });
        return f.call(select, {
          ifFalse: desaturated,
          ifTrue: shifted,
          condition: f.call(functions.less, { a: peak, b: startCompression }),
        });
      },
    ),
  ];
}
