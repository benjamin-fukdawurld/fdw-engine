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

// Integer operators, component-wise: the basis of the hash functions of
// the noises (noise.pcg…), identical on every backend. Unsigned integers
// wrap around on overflow (std.mul of two u32 keeps the low 32 bits).
const integerBinary = (id: string, op: IntrinsicOp) =>
  intrinsic(id, op, [port('a', integer), port('b', integer)], integer);

/** a % b, for integers (the sign of a for i32). */
export const remainder = integerBinary('remainder', 'remainder');
/** Bitwise and of integers. */
export const bitAnd = integerBinary('bitAnd', 'bit-and');
/** Bitwise or of integers. */
export const bitOr = integerBinary('bitOr', 'bit-or');
/** Bitwise exclusive or of integers. */
export const bitXor = integerBinary('bitXor', 'bit-xor');

/**
 * value << amount: the bits moved towards the high ones, zeros coming in.
 * The amount is below the bit count (32).
 */
export const shiftLeft = intrinsic(
  'shiftLeft',
  'shift-left',
  [port('value', integer), port('amount', integer)],
  integer,
);

/**
 * value >> amount: the bits moved towards the low ones; zeros coming in for
 * u32, the sign for i32. The amount is below the bit count (32).
 */
export const shiftRight = intrinsic(
  'shiftRight',
  'shift-right',
  [port('value', integer), port('amount', integer)],
  integer,
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
/** The base 2 logarithm, for x > 0. */
export const log2 = unaryFloat('log2', 'log2');
/** 2 raised to the power x. */
export const exp2 = unaryFloat('exp2', 'exp2');
/** The angle whose cosine is x, in [0, π], for x in [-1, 1]. */
export const acos = unaryFloat('acos', 'acos');
/** The angle of the point (x, y) from the x axis, in [-π, π]. */
export const atan2 = intrinsic(
  'atan2',
  'atan2',
  [port('y', float), port('x', float)],
  float,
);

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

// Unsigned integer vectors from their components (hashes, cells).
const unsignedVector = (size: 2 | 3 | 4) =>
  intrinsic(
    `uvec${size}`,
    'construct',
    ['x', 'y', 'z', 'w']
      .slice(0, size)
      .map((name) => port(name, BuiltinTypes.u32, 0)),
    { kind: 'vector', size, scalar: 'u32' },
  );

/** A vec2<u32> from its components. */
export const uvec2 = unsignedVector(2);
/** A vec3<u32> from its components. */
export const uvec3 = unsignedVector(3);
/** A vec4<u32> from its components. */
export const uvec4 = unsignedVector(4);

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

/** A 4 × 4 matrix from its columns. */
export const mat4 = intrinsic(
  'mat4',
  'construct',
  [
    port('c0', BuiltinTypes.vec4f),
    port('c1', BuiltinTypes.vec4f),
    port('c2', BuiltinTypes.vec4f),
    port('c3', BuiltinTypes.vec4f),
  ],
  BuiltinTypes.mat4f,
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

/**
 * The bits of a 32 bits scalar or vector seen as another scalar kind
 * (f32 ↔ u32 ↔ i32): `to` is the type of the result, of the same size.
 */
export const bitcast: FunctionDefinition = {
  id: 'std.bitcast',
  category: 'function',
  description:
    'The bits of a 32 bits value seen as another scalar kind (f32 ↔ u32 ↔ i32).',
  implementation: { kind: 'intrinsic', op: 'bitcast' },
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
  log2,
  exp2,
  acos,
  atan2,
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
  remainder,
  bitAnd,
  bitOr,
  bitXor,
  shiftLeft,
  shiftRight,
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
  uvec2,
  uvec3,
  uvec4,
  extend,
  mat3,
  mat4,
  transform,
  transform3,
  convert,
  bitcast,
];
