import { NodeRegistry } from '../graph/NodeRegistry';
import type { NodeDefinition } from '../graph/NodeDefinition';
import * as constants from './constants';
import * as functions from './functions';
import * as inputs from './inputs';
import * as outputs from './outputs';

export { ShadingModelNames } from './outputs';
export type { ShadingModel } from './outputs';

// Standard functions, by short name: g.call(std.mul, { a, b }).
export const std = {
  add: functions.add,
  sub: functions.sub,
  mul: functions.mul,
  div: functions.div,
  min: functions.min,
  max: functions.max,
  abs: functions.abs,
  floor: functions.floor,
  fract: functions.fract,
  sqrt: functions.sqrt,
  sin: functions.sin,
  cos: functions.cos,
  saturate: functions.saturate,
  pow: functions.pow,
  dot: functions.dot,
  length: functions.length,
  normalize: functions.normalize,
  cross: functions.cross,
  reflect: functions.reflect,
  mix: functions.mix,
  clamp: functions.clamp,
  smoothstep: functions.smoothstep,
  select: functions.select,
  textureSample: functions.textureSample,
  vec2: functions.vec2,
  vec3: functions.vec3,
  vec4: functions.vec4,
  extend: functions.extend,
  convert: functions.convert,
} as const;

export const stdInputs = {
  attribute: inputs.attribute,
  uniform: inputs.uniform,
  storage: inputs.storage,
  texture: inputs.textureInput,
  sampler: inputs.samplerInput,
  builtin: inputs.builtin,
  engine: inputs.engine,
} as const;

export const stdConstants = {
  value: constants.value,
  pi: constants.pi,
} as const;

export const stdOutputs = {
  surface: outputs.surface,
} as const;

export const standardNodeDefinitions: readonly NodeDefinition[] = [
  ...Object.values(stdInputs),
  ...Object.values(stdConstants),
  ...functions.functionDefinitions,
  ...Object.values(stdOutputs),
];

export function createStandardRegistry(): NodeRegistry {
  return new NodeRegistry(standardNodeDefinitions);
}
