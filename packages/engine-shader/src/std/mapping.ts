import { defineFunction } from '../graph/functions';
import { GraphBuilder } from '../graph/GraphBuilder';
import type { ValueSource } from '../graph/MaterialGraphData';
import type {
  FunctionDefinition,
  MacroContext,
  MacroDefinition,
  NodeDefinition,
  PortContext,
  PortSchema,
  StaticParams,
} from '../graph/NodeDefinition';
import type { NodeRegistry } from '../graph/NodeRegistry';
import { generic, PortType } from '../types/PortType';
import { BuiltinTypes } from '../types/ShaderType';
import { call, swizzle, vertexNormal, worldPosition } from './macros';
import { Ops } from './ops';

// Where procedural materials are computed: the coordinates of the object
// or of the world (no uv needed), and the triplanar mapping, which reads a
// 2d pattern or texture on the three planes of the axes and blends them by
// the normal (terrains, objects without uv).

const vec3 = BuiltinTypes.vec3f;
const f32 = BuiltinTypes.f32;

/** The mapping functions of the standard library. */
export function createMappingFunctions(
  registry: NodeRegistry,
): FunctionDefinition[] {
  const f = new GraphBuilder('mapping.triplanarWeights', registry);
  const o = new Ops(f);
  const normal = f.functionInput('normal', vec3);
  const sharpness = f.functionInput('sharpness', f32, { default: 4 });
  const w = o.pow(o.abs(normal), sharpness);
  f.functionOutput('weights', o.div(w, o.dot(w, [1, 1, 1])));
  return [
    defineFunction(f.build(), {
      id: 'mapping.triplanarWeights',
      description:
        'The weights of the planes of the axes (yz, xz, xy) for a normal, adding up to 1: the higher the sharpness, the narrower the blend between them.',
      registry,
    }),
  ];
}

/**
 * A function node called by a macro: its ports, with one given by the
 * macro (`given`: the uv of the triplanar mapping); its other inputs are
 * inputs of the macro.
 */
export function macroBody(
  params: StaticParams,
  context: PortContext | undefined,
  given: string,
  macro: string,
): { inputs: readonly PortSchema[]; output?: PortSchema } {
  const id = params['body'] as string;
  const body = context?.registry?.get(id);
  if (!context?.registry) {
    return { inputs: [] };
  }
  if (!body) {
    throw new Error(`${macro}: unknown body function "${id}"`);
  }
  const inputs = body.inputs({});
  const output = body.outputs({})[0];
  if (!inputs.some((input) => input.name === given) || !output) {
    throw new Error(
      `${macro}: the body "${id}" needs a "${given}" input and an output`,
    );
  }
  return {
    inputs: inputs.filter((input) => input.name !== given),
    output,
  };
}

// The inputs of a macro given to its body, all but its own.
function passThrough(
  context: MacroContext,
  own: readonly string[],
): Record<string, ValueSource | undefined> {
  const inputs: Record<string, ValueSource | undefined> = {};
  for (const port of context.ports) {
    if (!own.includes(port.name)) {
      inputs[port.name] = context.input(port.name);
    }
  }
  return inputs;
}

// The position and the normal of a triplanar macro: its inputs, else those
// of the world, per fragment.
const triplanarInputs: PortSchema[] = [
  // The point mapped: the world position of the fragment by default.
  { name: 'position', type: vec3, optional: true },
  // The normal blending the planes: the world normal by default.
  { name: 'normal', type: vec3, optional: true },
  // The number of repetitions per unit of the position.
  { name: 'scale', type: f32, default: 1 },
  { name: 'sharpness', type: f32, default: 4 },
];
const triplanarPorts = triplanarInputs.map((port) => port.name);

// The weights and the uv of the three planes, x, y, z.
function triplanarPlanes(context: MacroContext) {
  const position = call(context, 'std.mul', {
    a: context.input('position') ?? worldPosition(context),
    b: context.input('scale'),
  });
  const normal = context.input('normal')
    ? call(context, 'std.normalize', { x: context.input('normal') })
    : vertexNormal(context);
  const weights = call(context, 'mapping.triplanarWeights', {
    normal,
    sharpness: context.input('sharpness'),
  });
  return [
    { uv: swizzle(position, 'zy'), weight: swizzle(weights, 'x') },
    { uv: swizzle(position, 'xz'), weight: swizzle(weights, 'y') },
    { uv: swizzle(position, 'xy'), weight: swizzle(weights, 'z') },
  ];
}

// The planes blended: Σ value × weight.
function blend(
  context: MacroContext,
  values: readonly { value: ValueSource; weight: ValueSource }[],
): ValueSource {
  return values
    .map(({ value, weight }) =>
      call(context, 'std.mul', { a: value, b: weight }),
    )
    .reduce((sum, term) => call(context, 'std.add', { a: sum, b: term }));
}

const result = generic('T', 'any');

/**
 * Triplanar mapping of a function: the body, a function node with a `uv`
 * input, called on the three planes of the axes (yz, xz, xy) of the
 * position, its results blended by the normal. Its other inputs are inputs
 * of the macro. Without uv, without stretching on the slopes; three calls
 * of the body.
 */
export const triplanar: MacroDefinition = {
  id: 'mapping.triplanar',
  category: 'macro',
  description:
    'A function of a uv on the three planes of the axes, blended by the normal.',
  params: { body: { kind: 'string', required: true } },
  inputs: (params, context) => [
    ...triplanarInputs,
    ...macroBody(params, context, 'uv', 'mapping.triplanar').inputs,
  ],
  outputs: (params, context) => [
    {
      name: 'result',
      type: (macroBody(params, context, 'uv', 'mapping.triplanar').output
        ?.type ?? result) as PortType,
    },
  ],
  expand: (context) => {
    const body = context.params['body'] as string;
    const inputs = passThrough(context, triplanarPorts);
    return {
      result: blend(
        context,
        triplanarPlanes(context).map(({ uv, weight }) => ({
          value: context.add(body, {}, { ...inputs, uv })(),
          weight,
        })),
      ),
    };
  },
};

/**
 * Triplanar mapping of a texture: read on the three planes of the axes of
 * the position (scaled), blended by the normal. Fragment stage only (three
 * reads with derivatives).
 */
export const triplanarTexture: MacroDefinition = {
  id: 'mapping.triplanarTexture',
  category: 'macro',
  description:
    'A texture read on the three planes of the axes, blended by the normal.',
  inputs: () => [
    { name: 'texture', type: BuiltinTypes.texture2d },
    { name: 'sampler', type: BuiltinTypes.sampler },
    ...triplanarInputs,
  ],
  outputs: () => [{ name: 'color', type: BuiltinTypes.vec4f }],
  expand: (context) => ({
    color: blend(
      context,
      triplanarPlanes(context).map(({ uv, weight }) => ({
        value: call(context, 'std.textureSample', {
          texture: context.input('texture'),
          sampler: context.input('sampler'),
          uv,
        }),
        weight,
      })),
    ),
  }),
};

const coordinates = (
  id: string,
  description: string,
  value: (context: MacroContext) => ValueSource,
): MacroDefinition => ({
  id,
  category: 'macro',
  description,
  inputs: () => [],
  outputs: () => [{ name: 'value', type: vec3 }],
  expand: (context) => ({ value: value(context) }),
});

const attribute = (context: MacroContext, semantic: string) =>
  call(context, 'std.perFragment', {
    value: context.add('input.attribute', { semantic, type: vec3 })(),
  });

/**
 * The position of the fragment in the space of the object (the position of
 * the mesh, per fragment): a procedural material that moves with the
 * object. In a static batch (P12), the meshes are merged in the world:
 * the position of the object is then the world position.
 */
export const objectPosition = coordinates(
  'mapping.objectPosition',
  'The position of the fragment in the space of the object, per fragment.',
  (context) => attribute(context, 'position'),
);

/**
 * The position of the fragment in the world, per fragment: a procedural
 * material continuous from an object to the next (a terrain, walls).
 */
export const worldPositionNode = coordinates(
  'mapping.worldPosition',
  'The position of the fragment in the world, per fragment.',
  worldPosition,
);

/** The normal of the mesh in the space of the object, per fragment. */
export const objectNormal = coordinates(
  'mapping.objectNormal',
  'The normal of the fragment in the space of the object, normalized per fragment.',
  (context) =>
    call(context, 'std.normalize', { x: attribute(context, 'normal') }),
);

/** The normal of the mesh in the world, per fragment. */
export const worldNormal = coordinates(
  'mapping.worldNormal',
  'The normal of the fragment in the world, normalized per fragment.',
  vertexNormal,
);

export const mappingDefinitions: readonly NodeDefinition[] = [
  triplanar,
  triplanarTexture,
  objectPosition,
  worldPositionNode,
  objectNormal,
  worldNormal,
];
