import { NodeRegistry } from '../graph/NodeRegistry';
import type { NodeDefinition } from '../graph/NodeDefinition';
import * as constants from './constants';
import * as functions from './functions';
import * as inputs from './inputs';
import { createColorFunctions } from './color';
import { createShadingModels } from './lighting';
import * as lights from './lights';
import * as macros from './macros';
import * as outputs from './outputs';
import * as subgraphs from './subgraphs';

export { ShadingModelNames } from './outputs';
export { defineShadingModel } from './lighting';
export { ToneMappingNames } from './color';
export type { ToneMapping } from './color';
export type { ShadingModel } from './outputs';

/**
 * The standard functions, by short name.
 *
 * Arithmetic (`add`, `sub`, `mul`, `div`, `min`, `max`, `abs`, `floor`,
 * `fract`, `sqrt`, `sin`, `cos`, `pow`, `saturate`, `step`), vectors (`dot`,
 * `cross`, `length`, `normalize`, `reflect`), interpolation (`mix`, `clamp`,
 * `smoothstep`, `select`), comparisons (`less`, `lessEqual`, `greater`,
 * `greaterEqual`, `equal`, `notEqual`), textures (`textureSample`), construction (`vec2`,
 * `vec3`, `vec4`, `extend`, `convert`), transforms (`transform`,
 * `transform3`) and `perFragment`.
 *
 * @example
 * ```ts
 * const color = g.call(std.mul, { a: texel, b: tint });
 * ```
 *
 * @group Standard library
 */
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
  step: functions.step,
  perFragment: functions.perFragment,
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
  less: functions.less,
  lessEqual: functions.lessEqual,
  greater: functions.greater,
  greaterEqual: functions.greaterEqual,
  equal: functions.equal,
  notEqual: functions.notEqual,
  textureSample: functions.textureSample,
  vec2: functions.vec2,
  vec3: functions.vec3,
  vec4: functions.vec4,
  extend: functions.extend,
  transform: functions.transform,
  transform3: functions.transform3,
  convert: functions.convert,
} as const;

/**
 * The input node types: attribute, uniform, storage, texture, sampler,
 * builtin and engine values.
 *
 * @group Standard library
 */
export const stdInputs = {
  attribute: inputs.attribute,
  uniform: inputs.uniform,
  storage: inputs.storage,
  texture: inputs.textureInput,
  sampler: inputs.samplerInput,
  builtin: inputs.builtin,
  engine: inputs.engine,
} as const;

/**
 * The constant node types.
 *
 * @group Standard library
 */
export const stdConstants = {
  value: constants.value,
  pi: constants.pi,
} as const;

/**
 * The output node types: `output.surface`, and the raw `output.vertex` /
 * `output.fragment`.
 *
 * @group Standard library
 */
export const stdOutputs = {
  surface: outputs.surface,
  vertex: outputs.vertex,
  fragment: outputs.fragment,
} as const;

/**
 * The nodes of function graphs: `input` and `output`, the ports of the
 * function. See {@link defineFunction}.
 *
 * @group Standard library
 */
export const stdFunctionPorts = {
  input: subgraphs.input,
  output: subgraphs.output,
} as const;

/**
 * The lights of the frame: `current`, the light being summed, and `sum`,
 * the sum of a value over the lights. Used by the lit shading models, and
 * by custom ones.
 *
 * @group Standard library
 */
export const stdLights = {
  current: lights.current,
  sum: lights.sum,
} as const;

/**
 * Macros, by short name: g.node(stdMacros.staticSwitch, { params, inputs }).
 *
 * @group Standard library
 */
export const stdMacros = {
  staticSwitch: macros.staticSwitch,
  optionalAttribute: macros.optionalAttribute,
  repeat: macros.repeat,
  normalMapping: macros.normalMapping,
} as const;

export { call, engineValue, swizzle } from './macros';
export type { MacroInputs } from './macros';

/**
 * All the node types of the standard library, macros and shading models
 * included.
 *
 * @group Standard library
 */
const baseDefinitions: readonly NodeDefinition[] = [
  ...Object.values(stdInputs),
  ...Object.values(stdConstants),
  ...functions.functionDefinitions,
  ...Object.values(stdOutputs),
  ...lights.lightDefinitions,
  ...subgraphs.subgraphDefinitions,
  ...macros.macroDefinitions,
];

// The shading models and the color functions are function graphs, built
// with the other standard
// node types on first use (not when the modules load: the graph builder
// depends on this module).
let shadingModels: readonly NodeDefinition[] | undefined;
let buildingShadingModels = false;

/**
 * All the node types of the standard library, macros and shading models
 * included.
 *
 * @group Standard library
 */
export function standardNodeDefinitions(): readonly NodeDefinition[] {
  if (!shadingModels) {
    // Building the models uses the graph builder, which asks for the
    // standard definitions: the base ones are enough meanwhile.
    if (buildingShadingModels) {
      return baseDefinitions;
    }
    buildingShadingModels = true;
    try {
      const base = new NodeRegistry(baseDefinitions);
      shadingModels = [
        ...createColorFunctions(base),
        ...createShadingModels(base),
      ];
    } finally {
      buildingShadingModels = false;
    }
  }
  return [...baseDefinitions, ...shadingModels];
}

/**
 * A registry with all the node types of the standard library.
 *
 * @group Standard library
 */
export function createStandardRegistry(): NodeRegistry {
  return new NodeRegistry(standardNodeDefinitions());
}
