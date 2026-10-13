import {
  ShaderType,
  BuiltinTypes,
  texture,
  TextureDimension,
  TextureDimensionNames,
  TextureSampleType,
  TextureSampleTypeNames,
} from '../types/ShaderType';
import type { NodeDefinition, ShaderStage } from '../graph/NodeDefinition';

// Uniforms, textures and samplers belong to a binding slot, matching the
// MaterialBindingSlot of engine-backend: 'frame', 'material', 'object', or a
// custom slot.
const slotParam = { kind: 'string', default: 'material' } as const;

export const attribute: NodeDefinition = {
  id: 'input.attribute',
  category: 'input',
  description: 'A vertex attribute of the mesh, identified by its semantic.',
  params: {
    semantic: { kind: 'string', required: true },
    type: { kind: 'type', required: true },
  },
  inputs: () => [],
  outputs: (params) => [{ name: 'value', type: params['type'] as ShaderType }],
};

export const uniform: NodeDefinition = {
  id: 'input.uniform',
  category: 'input',
  description:
    'A uniform value, set on the material without recompiling the shader.',
  params: {
    name: { kind: 'string', required: true },
    type: { kind: 'type', required: true },
    slot: slotParam,
    // Initial value of the uniform on new materials.
    default: { kind: 'constant' },
  },
  inputs: () => [],
  outputs: (params) => [{ name: 'value', type: params['type'] as ShaderType }],
};

export const storage: NodeDefinition = {
  id: 'input.storage',
  category: 'input',
  description:
    'A storage buffer: a runtime-sized array, read with std.index and std.arrayLength.',
  params: {
    name: { kind: 'string', required: true },
    type: { kind: 'type', required: true },
    slot: slotParam,
    access: { kind: 'string', values: ['read', 'read-write'], default: 'read' },
  },
  inputs: () => [],
  outputs: (params) => [{ name: 'value', type: params['type'] as ShaderType }],
};

export const textureInput: NodeDefinition = {
  id: 'input.texture',
  category: 'input',
  params: {
    name: { kind: 'string', required: true },
    dimension: { kind: 'string', values: TextureDimensionNames, default: '2d' },
    sampleType: {
      kind: 'string',
      values: TextureSampleTypeNames,
      default: 'float',
    },
    slot: slotParam,
  },
  inputs: () => [],
  outputs: (params) => [
    {
      name: 'value',
      type: texture(
        params['dimension'] as TextureDimension,
        params['sampleType'] as TextureSampleType
      ),
    },
  ],
};

export const samplerInput: NodeDefinition = {
  id: 'input.sampler',
  category: 'input',
  params: {
    name: { kind: 'string', required: true },
    comparison: { kind: 'boolean', default: false },
    slot: slotParam,
  },
  inputs: () => [],
  outputs: (params) => [
    {
      name: 'value',
      type: params['comparison']
        ? BuiltinTypes.comparisonSampler
        : BuiltinTypes.sampler,
    },
  ],
};

const builtins: Record<string, { type: ShaderType; stage: ShaderStage }> = {
  'vertex-index': { type: BuiltinTypes.u32, stage: 'vertex' },
  'instance-index': { type: BuiltinTypes.u32, stage: 'vertex' },
  // The row of the object drawn in the object table (backends with the
  // objectTable capability).
  'object-index': { type: BuiltinTypes.u32, stage: 'vertex' },
  'frag-coord': { type: BuiltinTypes.vec4f, stage: 'fragment' },
  'front-facing': { type: BuiltinTypes.bool, stage: 'fragment' },
  // Graphs ending with output.fullscreen: the coordinates of the pixel in the
  // target, in [0, 1], origin at the top left on every backend.
  'screen-uv': { type: BuiltinTypes.vec2f, stage: 'fragment' },
  // Compute graphs: position of the thread in the grid, in its workgroup, of
  // its workgroup, and the number of workgroups.
  'global-invocation-id': { type: BuiltinTypes.vec3u, stage: 'compute' },
  'local-invocation-id': { type: BuiltinTypes.vec3u, stage: 'compute' },
  'workgroup-id': { type: BuiltinTypes.vec3u, stage: 'compute' },
  'num-workgroups': { type: BuiltinTypes.vec3u, stage: 'compute' },
};

export const builtin: NodeDefinition = {
  id: 'input.builtin',
  category: 'input',
  params: {
    builtin: { kind: 'string', values: Object.keys(builtins), required: true },
  },
  inputs: () => [],
  outputs: (params) => [
    { name: 'value', type: builtins[params['builtin'] as string].type },
  ],
  stage: (params) => builtins[params['builtin'] as string]?.stage,
};

// Values provided by the engine in the 'frame' and 'object' slots, shared by
// every material. Materials never declare them as uniforms.
const engineValues: Record<string, ShaderType> = {
  'camera.view': BuiltinTypes.mat4f,
  'camera.projection': BuiltinTypes.mat4f,
  'camera.viewProjection': BuiltinTypes.mat4f,
  'camera.position': BuiltinTypes.vec3f,
  'object.world': BuiltinTypes.mat4f,
  'object.normalMatrix': BuiltinTypes.mat3f,
  // The identifier of the object drawn (0: none), from the object table.
  'object.id': BuiltinTypes.u32,
  time: BuiltinTypes.f32,
  exposure: BuiltinTypes.f32,
  // The shadow atlas of the lights, read by the light.shadow macro.
  shadowMap: BuiltinTypes.depthTexture2d,
  shadowSampler: BuiltinTypes.comparisonSampler,
};

// The members of a row of the object table (objectTableMembers).
const objectMembers: Record<string, ShaderType> = {
  world: BuiltinTypes.mat4f,
  normalColumn0: BuiltinTypes.vec4f,
  normalColumn1: BuiltinTypes.vec4f,
  normalColumn2: BuiltinTypes.vec4f,
};

/**
 * A member of a row of the object table: what input.engine `object.world`,
 * `object.normalMatrix` and `object.id` become on the backends with the
 * objectTable capability, reading the row `index` (input.builtin
 * `object-index`).
 * Produced by the compiler; a graph has no reason to use it.
 */
export const object: NodeDefinition = {
  id: 'input.object',
  category: 'input',
  description: 'A member of the row of the object drawn, in the object table.',
  params: {
    member: {
      kind: 'string',
      values: Object.keys(objectMembers),
      required: true,
    },
  },
  inputs: () => [{ name: 'index', type: BuiltinTypes.u32 }],
  outputs: (params) => [
    { name: 'value', type: objectMembers[params['member'] as string] },
  ],
};

export const engine: NodeDefinition = {
  id: 'input.engine',
  category: 'input',
  description:
    'A value provided by the engine (camera, object transform, time).',
  params: {
    value: {
      kind: 'string',
      values: Object.keys(engineValues),
      required: true,
    },
  },
  inputs: () => [],
  outputs: (params) => [
    { name: 'value', type: engineValues[params['value'] as string] },
  ],
};
