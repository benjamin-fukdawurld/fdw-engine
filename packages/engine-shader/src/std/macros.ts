import type { ValueSource } from '../graph/MaterialGraphData';
import type { MacroContext, MacroDefinition } from '../graph/NodeDefinition';
import { composeSwizzles } from '../graph/swizzle';
import type { ConstantValue } from '../types/ConstantValue';
import { generic } from '../types/PortType';
import { ShaderType, BuiltinTypes } from '../types/ShaderType';

const any = generic('T', 'any');

type Inputs = Readonly<Record<string, ValueSource | ConstantValue | undefined>>;

// Helpers for macro bodies: call a function node and get its output, swizzle
// a value.
export const call = (
  context: MacroContext,
  type: string,
  inputs: Inputs
): ValueSource => context.add(type, {}, inputs)();

export const engineValue = (
  context: MacroContext,
  value: string
): ValueSource => context.add('input.engine', { value })();

export function swizzle(source: ValueSource, mask: string): ValueSource {
  if (!('ref' in source)) {
    throw new Error('A literal cannot be swizzled');
  }
  const combined = source.swizzle
    ? composeSwizzles(source.swizzle, mask)
    : mask;
  if (!combined) {
    throw new Error(`Invalid swizzle .${mask} of .${source.swizzle}`);
  }
  return { ref: source.ref, swizzle: combined };
}

// Chooses one of two values from a static parameter: only the chosen branch
// is compiled, the other one is removed as dead code.
export const staticSwitch: MacroDefinition = {
  id: 'macro.staticSwitch',
  category: 'macro',
  description: 'ifTrue when the feature is truthy, ifFalse otherwise.',
  params: { feature: { kind: 'string', required: true } },
  inputs: () => [
    { name: 'ifTrue', type: any },
    { name: 'ifFalse', type: any },
  ],
  outputs: () => [{ name: 'result', type: any }],
  expand: (context) => {
    const chosen = context.feature(context.params['feature'] as string)
      ? 'ifTrue'
      : 'ifFalse';
    return { result: context.input(chosen) as ValueSource };
  },
};

// A vertex attribute when the mesh has it, a fallback value otherwise: one
// material for meshes with and without vertex colors, tangents…
export const optionalAttribute: MacroDefinition = {
  id: 'macro.optionalAttribute',
  category: 'macro',
  params: {
    semantic: { kind: 'string', required: true },
    type: { kind: 'type', required: true },
  },
  inputs: (params) => [
    { name: 'fallback', type: params['type'] as ShaderType },
  ],
  outputs: (params) => [{ name: 'value', type: params['type'] as ShaderType }],
  expand: (context) => {
    const { semantic, type } = context.params;
    return {
      value: context.feature(`hasAttribute.${semantic}`)
        ? context.add('input.attribute', { semantic, type })()
        : (context.input('fallback') as ValueSource),
    };
  },
};

// Applies a function node `count` times: result = body(…body(body(initial))).
// The body node type needs a 'value' input, and may have an 'index' input
// receiving the iteration number (0, 1, 2…).
export const repeat: MacroDefinition = {
  id: 'macro.repeat',
  category: 'macro',
  params: {
    body: { kind: 'string', required: true },
    count: { kind: 'number', required: true },
  },
  inputs: () => [{ name: 'initial', type: any }],
  outputs: () => [{ name: 'result', type: any }],
  expand: (context) => {
    const body = context.params['body'] as string;
    const count = context.params['count'] as number;
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`count must be a non-negative integer, got ${count}`);
    }
    const withIndex = context.hasInput(body, 'index');
    let value = context.input('initial') as ValueSource;
    for (let index = 0; index < count; index++) {
      value = call(context, body, withIndex ? { value, index } : { value });
    }
    return { result: value };
  },
};

// Direction transformed by the normal matrix and normalized per fragment:
// interpolated directions are not unit vectors.
function worldDirection(
  context: MacroContext,
  vector: ValueSource
): ValueSource {
  const transformed = call(context, 'std.transform3', {
    matrix: engineValue(context, 'object.normalMatrix'),
    vector,
  });
  return call(context, 'std.normalize', {
    x: call(context, 'std.perFragment', { value: transformed }),
  });
}

// World-space normal of the fragment from the mesh normals.
export const vertexNormal = (context: MacroContext): ValueSource =>
  worldDirection(
    context,
    context.add('input.attribute', {
      semantic: 'normal',
      type: BuiltinTypes.vec3f,
    })()
  );

// World-space normal perturbed by a tangent-space normal map, when the mesh
// has tangents (xyz: tangent, w: handedness). Without tangents, the
// interpolated normal is used and the map is ignored.
export const normalMapping: MacroDefinition = {
  id: 'macro.normalMapping',
  category: 'macro',
  inputs: () => [
    // Texel of the normal map, in [0, 1].
    { name: 'sample', type: BuiltinTypes.vec3f },
    { name: 'strength', type: BuiltinTypes.f32, default: 1 },
  ],
  outputs: () => [{ name: 'normal', type: BuiltinTypes.vec3f }],
  expand: (context) => {
    const n = vertexNormal(context);
    if (!context.feature('hasAttribute.tangent')) {
      return { normal: n };
    }

    const tangent = context.add('input.attribute', {
      semantic: 'tangent',
      type: BuiltinTypes.vec4f,
    })();
    const t = worldDirection(context, swizzle(tangent, 'xyz'));
    const b = call(context, 'std.mul', {
      a: call(context, 'std.cross', { a: n, b: t }),
      b: swizzle(tangent, 'w'),
    });

    // From [0, 1] to [-1, 1], with the xy deviation scaled by the strength.
    const m = call(context, 'std.sub', {
      a: call(context, 'std.mul', { a: context.input('sample'), b: 2 }),
      b: 1,
    });
    const strength = context.input('strength');
    const along = (axis: ValueSource, component: string, scaled: boolean) =>
      call(context, 'std.mul', {
        a: axis,
        b: scaled
          ? call(context, 'std.mul', { a: swizzle(m, component), b: strength })
          : swizzle(m, component),
      });
    const perturbed = call(context, 'std.add', {
      a: call(context, 'std.add', {
        a: along(t, 'x', true),
        b: along(b, 'y', true),
      }),
      b: along(n, 'z', false),
    });
    return { normal: call(context, 'std.normalize', { x: perturbed }) };
  },
};

export const macroDefinitions: readonly MacroDefinition[] = [
  staticSwitch,
  optionalAttribute,
  repeat,
  normalMapping,
];
