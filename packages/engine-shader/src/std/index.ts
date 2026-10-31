import { NodeRegistry } from '../graph/NodeRegistry';
import type { NodeDefinition } from '../graph/NodeDefinition';
import * as constants from './constants';
import * as functions from './functions';
import * as inputs from './inputs';
import { createCameraFunctions } from './camera';
import { createColorFunctions } from './color';
import { createShadingModels } from './lighting';
import * as environment from './environment';
import { createEnvironmentFunctions } from './environment';
import * as fractal from './fractal';
import * as lights from './lights';
import * as loops from './loops';
import * as macros from './macros';
import * as mapping from './mapping';
import { createMappingFunctions } from './mapping';
import { createNoiseFunctions } from './noise';
import { createPatternFunctions } from './patterns';
import * as outputs from './outputs';
import * as rays from './rays';
import { createRayFunctions } from './rays';
import * as subgraphs from './subgraphs';

export { ShadingModelNames } from './outputs';
export { defineShadingModel } from './lighting';
export { ToneMappingNames } from './color';
export { NoiseNames } from './fractal';
export type { NoiseName } from './fractal';
export type { ToneMapping } from './color';
export type { ShadingModel } from './outputs';

/**
 * The standard functions, by short name.
 *
 * Arithmetic (`add`, `sub`, `mul`, `div`, `min`, `max`, `abs`, `floor`,
 * `fract`, `sqrt`, `log2`, `exp2`, `sin`, `cos`, `acos`, `atan2`, `pow`,
 * `saturate`, `step`), vectors (`dot`, `cross`, `length`, `normalize`,
 * `reflect`), interpolation (`mix`, `clamp`, `smoothstep`, `select`),
 * comparisons (`less`, `lessEqual`, `greater`, `greaterEqual`, `equal`,
 * `notEqual`), arrays (`index`, `arrayLength`,
 * for storage buffers), integers (`remainder`, `bitAnd`, `bitOr`,
 * `bitXor`, `shiftLeft`, `shiftRight`), textures (`textureSample`, `textureSampleLevel`,
 * `textureSampleCube`, `textureSampleCubeLevel`, `textureLoad`,
 * `textureLoadDepth`), screen space derivatives
 * (`dpdx`, `dpdy`, `fwidth`, fragment stage only), construction (`vec2`,
 * `vec3`, `vec4`, `uvec2`, `uvec3`, `uvec4`, `extend`, `convert`), transforms (`transform`,
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
  log2: functions.log2,
  exp2: functions.exp2,
  acos: functions.acos,
  atan2: functions.atan2,
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
  index: functions.index,
  arrayLength: functions.arrayLength,
  remainder: functions.remainder,
  bitAnd: functions.bitAnd,
  bitOr: functions.bitOr,
  bitXor: functions.bitXor,
  shiftLeft: functions.shiftLeft,
  shiftRight: functions.shiftRight,
  less: functions.less,
  lessEqual: functions.lessEqual,
  greater: functions.greater,
  greaterEqual: functions.greaterEqual,
  equal: functions.equal,
  notEqual: functions.notEqual,
  textureSample: functions.textureSample,
  textureSampleLevel: functions.textureSampleLevel,
  textureSampleCompare: functions.textureSampleCompare,
  textureSampleCube: functions.textureSampleCube,
  textureSampleCubeLevel: functions.textureSampleCubeLevel,
  textureLoad: functions.textureLoad,
  textureLoadDepth: functions.textureLoadDepth,
  dpdx: functions.dpdx,
  dpdy: functions.dpdy,
  fwidth: functions.fwidth,
  vec2: functions.vec2,
  vec3: functions.vec3,
  vec4: functions.vec4,
  uvec2: functions.uvec2,
  uvec3: functions.uvec3,
  uvec4: functions.uvec4,
  extend: functions.extend,
  mat3: functions.mat3,
  mat4: functions.mat4,
  transform: functions.transform,
  transform3: functions.transform3,
  convert: functions.convert,
  bitcast: functions.bitcast,
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
  object: inputs.object,
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
 * The output node types: `output.surface`, `output.fullscreen` (post-processing
 * passes), the raw `output.vertex` / `output.fragment`, the extra color
 * targets `output.target`, the vertex attributes computed by the graph
 * `output.attribute`, and `output.compute` with the `write.storage` nodes of
 * the compute graphs.
 *
 * @group Standard library
 */
export const stdOutputs = {
  surface: outputs.surface,
  vertex: outputs.vertex,
  fragment: outputs.fragment,
  target: outputs.target,
  value: outputs.value,
  attribute: outputs.attribute,
  fullscreen: outputs.fullscreen,
  compute: outputs.compute,
  writeStorage: outputs.writeStorage,
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
 * The environment of the frame (image-based lighting): `light`, the light
 * of the environment a surface reflects, black without the `environment`
 * feature. The function graphs `environment.radiance`,
 * `environment.irradiance` and `environment.brdf` read the prefiltered
 * environment; `environment.octahedral`, `environment.equirect` and their
 * inverses map directions to textures.
 *
 * @group Standard library
 */
export const stdEnvironment = {
  light: environment.light,
} as const;

/**
 * The fold loops: `fold`, a loop over a function node, and its parts
 * `state`, `index` and `end` (see {@link GraphBuilder.fold}). The loop is
 * not unrolled: its count can be a uniform.
 *
 * @group Standard library
 */
export const stdLoops = {
  fold: loops.fold,
  state: loops.state,
  index: loops.index,
  end: loops.end,
} as const;

/**
 * The noises, for points of 2 to 4 dimensions (the 4th one: time):
 * - the fractal sums `fbm`, `ridged`, `turbulence` and the domain warping
 *   `warp`, macros with the noise and the octaves as parameters;
 * - `value`, `perlin`, `simplex`, `worley`, the noise of the dimension of
 *   the point;
 * - by id, the function graphs they call: `noise.value2`…`noise.value4`,
 *   `noise.perlin2…4`, `noise.simplex2…4`, `noise.worley2…4`, the hashes
 *   `noise.pcg` (u32), `noise.pcg2d…4d`, `noise.hash2…4` (the cell of a
 *   point) and `noise.random2…4` (floats in [0, 1) per cell).
 *
 * The same noises in TypeScript: the package @fdw/engine-noise.
 *
 * @example
 * ```ts
 * const height = g.call(stdNoise.fbm, { point: position.swizzle('xz') }, {
 *   params: { noise: 'simplex', octaves: 6 },
 * });
 * ```
 *
 * @group Standard library
 */
export const stdNoise = {
  fbm: fractal.fbm,
  ridged: fractal.ridged,
  turbulence: fractal.turbulence,
  warp: fractal.warp,
  value: fractal.value,
  perlin: fractal.perlin,
  simplex: fractal.simplex,
  worley: fractal.worley,
} as const;

/**
 * The patterns, function graphs by id (from a uv: any 2d coordinates):
 * `checker`, `stripes`, their filtered versions `checkerFiltered`,
 * `stripesFiltered` (averaged over the pixel by the screen space
 * derivatives, fragment stage only), `bricks` and `tiles` (mask, position
 * in the cell, cell, distance to the edge).
 *
 * @example
 * ```ts
 * const bricks = g.node(stdPatterns.bricks, { inputs: { uv } });
 * const color = g.call(std.mix, { a: mortar, b: brick, t: bricks.mask });
 * ```
 *
 * @group Standard library
 */
export const stdPatterns = {
  checker: 'pattern.checker',
  checkerFiltered: 'pattern.checkerFiltered',
  stripes: 'pattern.stripes',
  stripesFiltered: 'pattern.stripesFiltered',
  bricks: 'pattern.bricks',
  tiles: 'pattern.tiles',
} as const;

/**
 * Where a procedural material is computed: the coordinates of the object
 * or of the world, per fragment (`objectPosition`, `worldPosition`,
 * `objectNormal`, `worldNormal`), and the triplanar mapping of a function
 * (`triplanar`) or of a texture (`triplanarTexture`), with its weights
 * (`mapping.triplanarWeights`, by id).
 *
 * @group Standard library
 */
export const stdMapping = {
  triplanar: mapping.triplanar,
  triplanarTexture: mapping.triplanarTexture,
  triplanarWeights: 'mapping.triplanarWeights',
  objectPosition: mapping.objectPosition,
  worldPosition: mapping.worldPositionNode,
  objectNormal: mapping.objectNormal,
  worldNormal: mapping.worldNormal,
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
  bumpMapping: macros.bumpMapping,
  parallaxMapping: macros.parallaxMapping,
  parallaxOcclusionMapping: macros.parallaxOcclusionMapping,
  displacement: macros.displacement,
} as const;

/**
 * Rays traced in the scene, by short name: `ray.trace` (the node), and the
 * functions of its hit (by id): g.call(stdRays.hitPosition, { hit }).
 *
 * @group Standard library
 */
export const stdRays = {
  trace: rays.trace,
  traceAlpha: rays.traceAlpha,
  hit: 'ray.hit',
  hitFrontFacing: 'ray.hitFrontFacing',
  hitBarycentrics: 'ray.hitBarycentrics',
  hitVertices: 'ray.hitVertices',
  hitPosition: 'ray.hitPosition',
  hitLocalPosition: 'ray.hitLocalPosition',
  hitNormal: 'ray.hitNormal',
  hitLocalNormal: 'ray.hitLocalNormal',
  hitGeometricNormal: 'ray.hitGeometricNormal',
  hitUv: 'ray.hitUv',
  hitLocalTangent: 'ray.hitLocalTangent',
  hitWorld: 'ray.hitWorld',
  hitNormalMatrix: 'ray.hitNormalMatrix',
  hitMaterial: 'ray.hitMaterial',
  hitObject: 'ray.hitObject',
  hitFlags: 'ray.hitFlags',
  hitData: 'ray.hitData',
} as const;

export { RayMiss } from './rays';
export { Ops } from './ops';
export type { Value } from './ops';

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
  ...environment.environmentDefinitions,
  ...loops.loopDefinitions,
  ...rays.rayDefinitions,
  ...fractal.fractalDefinitions,
  ...mapping.mappingDefinitions,
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
        // Before the shading models: the shadows by rays use them.
        ...createRayFunctions(base),
        ...createColorFunctions(base),
        ...createCameraFunctions(base),
        ...createEnvironmentFunctions(base),
        ...createShadingModels(base),
        ...createNoiseFunctions(base),
        ...createPatternFunctions(base),
        ...createMappingFunctions(base),
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
