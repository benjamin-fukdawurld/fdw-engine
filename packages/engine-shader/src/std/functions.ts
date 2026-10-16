import {
  arrayElementOf,
  boolOf,
  elementOf,
  generic,
  PortType,
} from '../types/PortType';
import { ShaderType, BuiltinTypes } from '../types/ShaderType';
import type {
  FunctionDefinition,
  IntrinsicOp,
  NodeDefinition,
  PortSchema,
  ShaderStage,
} from '../graph/NodeDefinition';

const numeric = generic('T', 'numeric');
const float = generic('T', 'float');
const floatVector = generic('T', 'float-vector');
const any = generic('T', 'any');

const port = (
  name: string,
  type: PortType,
  defaultValue?: number,
): PortSchema =>
  defaultValue === undefined
    ? { name, type }
    : { name, type, default: defaultValue };

function intrinsic(
  id: string,
  op: IntrinsicOp,
  inputs: readonly PortSchema[],
  result: PortType,
  stage?: ShaderStage,
): FunctionDefinition {
  return {
    id: `std.${id}`,
    category: 'function',
    implementation: { kind: 'intrinsic', op },
    inputs: () => inputs,
    outputs: () => [{ name: 'result', type: result }],
    ...(stage ? { stage: () => stage } : {}),
  };
}

const binary = (id: string, op: IntrinsicOp) =>
  intrinsic(id, op, [port('a', numeric), port('b', numeric)], numeric);

const unaryFloat = (id: string, op: IntrinsicOp) =>
  intrinsic(id, op, [port('x', float)], float);

export const add = binary('add', 'add');
export const sub = binary('sub', 'sub');
export const mul = binary('mul', 'mul');
export const div = binary('div', 'div');
export const min = binary('min', 'min');
export const max = binary('max', 'max');

export const abs = intrinsic('abs', 'abs', [port('x', numeric)], numeric);

// Component-wise comparisons: bool for scalars, vecN<bool> for vectors.
const comparison = (id: string, op: IntrinsicOp) =>
  intrinsic(id, op, [port('a', numeric), port('b', numeric)], boolOf('T'));

const array = generic('A', 'array');
const integer = generic('I', 'integer');

/** An element of an array (a storage buffer): array[index]. */
export const index = intrinsic(
  'index',
  'index',
  [port('array', array), port('index', integer)],
  arrayElementOf('A'),
);

/** The number of elements of a runtime-sized array (a storage buffer). */
export const arrayLength = intrinsic(
  'arrayLength',
  'array-length',
  [port('array', array)],
  BuiltinTypes.u32,
);

export const less = comparison('less', 'less');
export const lessEqual = comparison('lessEqual', 'less-equal');
export const greater = comparison('greater', 'greater');
export const greaterEqual = comparison('greaterEqual', 'greater-equal');
export const equal = comparison('equal', 'equal');
export const notEqual = comparison('notEqual', 'not-equal');
export const floor = unaryFloat('floor', 'floor');
export const fract = unaryFloat('fract', 'fract');
export const sqrt = unaryFloat('sqrt', 'sqrt');

// Screen space derivatives: computed by the neighboring pixels, so only in
// the fragment stage.
const derivative = (id: string, op: IntrinsicOp) =>
  intrinsic(id, op, [port('x', float)], float, 'fragment');

/**
 * The change of a value from a pixel to the next one, to the right: the
 * basis of bump mapping, of the tangent frames without tangents, of
 * antialiased procedural patterns. Fragment stage only.
 */
export const dpdx = derivative('dpdx', 'dpdx');

/**
 * The change of a value from a pixel to the next one, below (y points down,
 * as screen-uv). Fragment stage only.
 */
export const dpdy = derivative('dpdy', 'dpdy');

/**
 * |dpdx| + |dpdy|: how fast a value changes on the screen, typically the
 * width of a pixel in the units of the value (antialiased edges with
 * smoothstep). Fragment stage only.
 */
export const fwidth = derivative('fwidth', 'fwidth');
export const sin = unaryFloat('sin', 'sin');
export const cos = unaryFloat('cos', 'cos');
export const saturate = unaryFloat('saturate', 'saturate');

/** 0 when x < edge, 1 otherwise. */
export const step = intrinsic(
  'step',
  'step',
  [port('edge', float), port('x', float)],
  float,
);

/**
 * Returns its value unchanged, but only in the fragment stage: what depends on
 * it is computed per pixel instead of being interpolated. Typically used on a
 * normal or a position before normalizing or lighting.
 */
export const perFragment = intrinsic(
  'perFragment',
  'identity',
  [port('value', any)],
  any,
  'fragment',
);

export const pow = intrinsic(
  'pow',
  'pow',
  [port('base', float), port('exponent', float)],
  float,
);

export const dot = intrinsic(
  'dot',
  'dot',
  [port('a', floatVector), port('b', floatVector)],
  elementOf('T'),
);

export const length = intrinsic(
  'length',
  'length',
  [port('x', floatVector)],
  elementOf('T'),
);

export const normalize = intrinsic(
  'normalize',
  'normalize',
  [port('x', floatVector)],
  floatVector,
);

export const cross = intrinsic(
  'cross',
  'cross',
  [port('a', BuiltinTypes.vec3f), port('b', BuiltinTypes.vec3f)],
  BuiltinTypes.vec3f,
);

export const reflect = intrinsic(
  'reflect',
  'reflect',
  [port('incident', floatVector), port('normal', floatVector)],
  floatVector,
);

export const mix = intrinsic(
  'mix',
  'mix',
  [port('a', float), port('b', float), port('t', float)],
  float,
);

export const clamp = intrinsic(
  'clamp',
  'clamp',
  [port('x', numeric), port('low', numeric), port('high', numeric)],
  numeric,
);

export const smoothstep = intrinsic(
  'smoothstep',
  'smoothstep',
  [port('low', float), port('high', float), port('x', float)],
  float,
);

/** Branchless choice between two values: the graph has no control flow. */
export const select = intrinsic(
  'select',
  'select',
  [
    port('ifFalse', any),
    port('ifTrue', any),
    port('condition', BuiltinTypes.bool),
  ],
  any,
);

/**
 * Implicit-LOD sampling needs derivatives, so it is only valid in a fragment
 * shader.
 */
export const textureSample = intrinsic(
  'textureSample',
  'texture-sample',
  [
    port('texture', BuiltinTypes.texture2d),
    port('sampler', BuiltinTypes.sampler),
    port('uv', BuiltinTypes.vec2f),
  ],
  BuiltinTypes.vec4f,
  'fragment',
);

/**
 * Samples a texture at an explicit level of detail (0 for the full
 * resolution): available in every stage, where textureSample needs the
 * derivatives of the fragment stage.
 */
export const textureSampleLevel = intrinsic(
  'textureSampleLevel',
  'texture-sample-level',
  [
    port('texture', BuiltinTypes.texture2d),
    port('sampler', BuiltinTypes.sampler),
    port('uv', BuiltinTypes.vec2f),
    port('level', BuiltinTypes.f32, 0),
  ],
  BuiltinTypes.vec4f,
);

/**
 * Compares a reference depth with the depths of a depth texture around uv:
 * 1 where the reference passes the comparison of the sampler (for a shadow
 * map, `less-equal`: the point is lit), 0 where it fails, and the fraction
 * of the neighboring texels that pass with a linear comparison sampler.
 * Available in every stage and in loops: the level is always 0.
 */
export const textureSampleCompare = intrinsic(
  'textureSampleCompare',
  'texture-sample-compare',
  [
    port('texture', BuiltinTypes.depthTexture2d),
    port('sampler', BuiltinTypes.comparisonSampler),
    port('uv', BuiltinTypes.vec2f),
    port('depthRef', BuiltinTypes.f32),
  ],
  BuiltinTypes.f32,
);

/**
 * Reads a texel of a 2d texture by its integer coordinates (rows from the
 * top, as uv), at a level: no sampler, no filtering. Available in every
 * stage. Reads the textures that cannot be filtered (r32float, rgba32float:
 * declare them with `sampleType: 'unfilterable-float'`). Coordinates outside
 * of the level give an undefined value: clamp them.
 */
export const textureLoad = intrinsic(
  'textureLoad',
  'texture-load',
  [
    port('texture', generic('T', 'float-texture-2d')),
    port('coords', BuiltinTypes.vec2i),
    port('level', BuiltinTypes.i32, 0),
  ],
  BuiltinTypes.vec4f,
);

/**
 * Reads the depth of a texel of a depth texture (a depth attachment written
 * by earlier passes), by its integer coordinates: 0 at the near plane, 1 at
 * the far one. Available in every stage. Not for multisampled depth.
 */
export const textureLoadDepth = intrinsic(
  'textureLoadDepth',
  'texture-load',
  [
    port('texture', BuiltinTypes.depthTexture2d),
    port('coords', BuiltinTypes.vec2i),
    port('level', BuiltinTypes.i32, 0),
  ],
  BuiltinTypes.f32,
);

/**
 * Samples a cube texture in a direction (any length): the environment seen
 * in that direction. Fragment stage only, as textureSample.
 */
export const textureSampleCube = intrinsic(
  'textureSampleCube',
  'texture-sample',
  [
    port('texture', BuiltinTypes.textureCube),
    port('sampler', BuiltinTypes.sampler),
    port('direction', BuiltinTypes.vec3f),
  ],
  BuiltinTypes.vec4f,
  'fragment',
);

/**
 * Samples a cube texture in a direction at an explicit level of detail:
 * the higher the level, the blurrier the environment (glossy reflections,
 * the level chosen by the roughness).
 */
export const textureSampleCubeLevel = intrinsic(
  'textureSampleCubeLevel',
  'texture-sample-level',
  [
    port('texture', BuiltinTypes.textureCube),
    port('sampler', BuiltinTypes.sampler),
    port('direction', BuiltinTypes.vec3f),
    port('level', BuiltinTypes.f32, 0),
  ],
  BuiltinTypes.vec4f,
);

export const vec2 = intrinsic(
  'vec2',
  'construct',
  [port('x', BuiltinTypes.f32, 0), port('y', BuiltinTypes.f32, 0)],
  BuiltinTypes.vec2f,
);

export const vec3 = intrinsic(
  'vec3',
  'construct',
  [
    port('x', BuiltinTypes.f32, 0),
    port('y', BuiltinTypes.f32, 0),
    port('z', BuiltinTypes.f32, 0),
  ],
  BuiltinTypes.vec3f,
);

export const vec4 = intrinsic(
  'vec4',
  'construct',
  [
    port('x', BuiltinTypes.f32, 0),
    port('y', BuiltinTypes.f32, 0),
    port('z', BuiltinTypes.f32, 0),
    port('w', BuiltinTypes.f32, 0),
  ],
  BuiltinTypes.vec4f,
);

/** vec4(xyz, w): typically a color with its alpha, or a position with w = 1. */
export const extend = intrinsic(
  'extend',
  'construct',
  [port('xyz', BuiltinTypes.vec3f), port('w', BuiltinTypes.f32, 1)],
  BuiltinTypes.vec4f,
);

/** Matrix × vector products: transforming positions and directions. */
/** A 3 × 3 matrix from its columns. */
export const mat3 = intrinsic(
  'mat3',
  'construct',
  [
    port('c0', BuiltinTypes.vec3f),
    port('c1', BuiltinTypes.vec3f),
    port('c2', BuiltinTypes.vec3f),
  ],
  BuiltinTypes.mat3f,
);

export const transform = intrinsic(
  'transform',
  'mul',
  [port('matrix', BuiltinTypes.mat4f), port('vector', BuiltinTypes.vec4f)],
  BuiltinTypes.vec4f,
);

export const transform3 = intrinsic(
  'transform3',
  'mul',
  [port('matrix', BuiltinTypes.mat3f), port('vector', BuiltinTypes.vec3f)],
  BuiltinTypes.vec3f,
);

export const convert: FunctionDefinition = {
  id: 'std.convert',
  category: 'function',
  description:
    'Explicit conversion between scalar kinds (f32 ↔ i32 ↔ u32), component-wise for vectors.',
  implementation: { kind: 'intrinsic', op: 'convert' },
  params: { to: { kind: 'type', required: true } },
  inputs: () => [port('value', numeric)],
  outputs: (params) => [{ name: 'result', type: params['to'] as ShaderType }],
};

export const functionDefinitions: readonly NodeDefinition[] = [
  add,
  sub,
  mul,
  div,
  min,
  max,
  abs,
  floor,
  fract,
  sqrt,
  sin,
  cos,
  saturate,
  step,
  perFragment,
  pow,
  dot,
  length,
  normalize,
  cross,
  reflect,
  mix,
  clamp,
  smoothstep,
  select,
  index,
  arrayLength,
  less,
  lessEqual,
  greater,
  greaterEqual,
  equal,
  notEqual,
  textureSample,
  textureSampleLevel,
  textureSampleCompare,
  textureSampleCube,
  textureSampleCubeLevel,
  textureLoad,
  textureLoadDepth,
  dpdx,
  dpdy,
  fwidth,
  vec2,
  vec3,
  vec4,
  extend,
  mat3,
  transform,
  transform3,
  convert,
];
