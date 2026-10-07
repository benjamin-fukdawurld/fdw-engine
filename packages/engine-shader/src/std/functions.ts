import { elementOf, generic, PortType } from '../types/PortType';
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
  defaultValue?: number
): PortSchema =>
  defaultValue === undefined
    ? { name, type }
    : { name, type, default: defaultValue };

function intrinsic(
  id: string,
  op: IntrinsicOp,
  inputs: readonly PortSchema[],
  result: PortType,
  stage?: ShaderStage
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
export const floor = unaryFloat('floor', 'floor');
export const fract = unaryFloat('fract', 'fract');
export const sqrt = unaryFloat('sqrt', 'sqrt');
export const sin = unaryFloat('sin', 'sin');
export const cos = unaryFloat('cos', 'cos');
export const saturate = unaryFloat('saturate', 'saturate');

// 0 when x < edge, 1 otherwise.
export const step = intrinsic(
  'step',
  'step',
  [port('edge', float), port('x', float)],
  float
);

// Returns its value unchanged, but only in the fragment stage: what depends on
// it is computed per pixel instead of being interpolated. Typically used on a
// normal or a position before normalizing or lighting.
export const perFragment = intrinsic(
  'perFragment',
  'identity',
  [port('value', any)],
  any,
  'fragment'
);

export const pow = intrinsic(
  'pow',
  'pow',
  [port('base', float), port('exponent', float)],
  float
);

export const dot = intrinsic(
  'dot',
  'dot',
  [port('a', floatVector), port('b', floatVector)],
  elementOf('T')
);

export const length = intrinsic(
  'length',
  'length',
  [port('x', floatVector)],
  elementOf('T')
);

export const normalize = intrinsic(
  'normalize',
  'normalize',
  [port('x', floatVector)],
  floatVector
);

export const cross = intrinsic(
  'cross',
  'cross',
  [port('a', BuiltinTypes.vec3f), port('b', BuiltinTypes.vec3f)],
  BuiltinTypes.vec3f
);

export const reflect = intrinsic(
  'reflect',
  'reflect',
  [port('incident', floatVector), port('normal', floatVector)],
  floatVector
);

export const mix = intrinsic(
  'mix',
  'mix',
  [port('a', float), port('b', float), port('t', float)],
  float
);

export const clamp = intrinsic(
  'clamp',
  'clamp',
  [port('x', numeric), port('low', numeric), port('high', numeric)],
  numeric
);

export const smoothstep = intrinsic(
  'smoothstep',
  'smoothstep',
  [port('low', float), port('high', float), port('x', float)],
  float
);

// Branchless choice between two values: the graph has no control flow.
export const select = intrinsic(
  'select',
  'select',
  [
    port('ifFalse', any),
    port('ifTrue', any),
    port('condition', BuiltinTypes.bool),
  ],
  any
);

// Implicit-LOD sampling needs derivatives, so it is only valid in a fragment
// shader.
export const textureSample = intrinsic(
  'textureSample',
  'texture-sample',
  [
    port('texture', BuiltinTypes.texture2d),
    port('sampler', BuiltinTypes.sampler),
    port('uv', BuiltinTypes.vec2f),
  ],
  BuiltinTypes.vec4f,
  'fragment'
);

export const vec2 = intrinsic(
  'vec2',
  'construct',
  [port('x', BuiltinTypes.f32, 0), port('y', BuiltinTypes.f32, 0)],
  BuiltinTypes.vec2f
);

export const vec3 = intrinsic(
  'vec3',
  'construct',
  [
    port('x', BuiltinTypes.f32, 0),
    port('y', BuiltinTypes.f32, 0),
    port('z', BuiltinTypes.f32, 0),
  ],
  BuiltinTypes.vec3f
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
  BuiltinTypes.vec4f
);

// vec4(xyz, w): typically a color with its alpha, or a position with w = 1.
export const extend = intrinsic(
  'extend',
  'construct',
  [port('xyz', BuiltinTypes.vec3f), port('w', BuiltinTypes.f32, 1)],
  BuiltinTypes.vec4f
);

// Matrix × vector products: transforming positions and directions.
export const transform = intrinsic(
  'transform',
  'mul',
  [port('matrix', BuiltinTypes.mat4f), port('vector', BuiltinTypes.vec4f)],
  BuiltinTypes.vec4f
);

export const transform3 = intrinsic(
  'transform3',
  'mul',
  [port('matrix', BuiltinTypes.mat3f), port('vector', BuiltinTypes.vec3f)],
  BuiltinTypes.vec3f
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
  textureSample,
  vec2,
  vec3,
  vec4,
  extend,
  transform,
  transform3,
  convert,
];
