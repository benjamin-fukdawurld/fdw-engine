import { ShaderType, BuiltinTypes, TextureType } from '../types/ShaderType';

// Logical layout of the resources of a program: which resources, of which
// type, grouped by update frequency. Memory offsets and binding numbers are
// physical concerns, resolved by each backend.

/**
 * A resource of a program: a uniform block, a texture or a sampler.
 *
 * @group Program layout
 */
export type LogicalBinding =
  | {
      readonly kind: 'uniform-block';
      readonly name: string;
      readonly members: readonly {
        readonly name: string;
        readonly type: ShaderType;
      }[];
    }
  | {
      readonly kind: 'texture';
      readonly name: string;
      readonly type: TextureType;
    }
  | {
      readonly kind: 'sampler';
      readonly name: string;
      readonly comparison: boolean;
    };

/**
 * The resources of a slot.
 *
 * @group Program layout
 */
export interface ProgramLayoutGroup {
  readonly slot: string;
  readonly bindings: readonly LogicalBinding[];
}

/**
 * Logical layout of the resources of a program: which resources, of which
 * type, grouped by update frequency. Memory offsets and binding numbers are
 * resolved by each backend.
 *
 * @group Program layout
 */
export interface ProgramLayout {
  readonly groups: readonly ProgramLayoutGroup[];
}

/**
 * Fixed slots, always present and in this order, so that their group index
 * is the same in every program. Custom slots follow, sorted by name.
 *
 * @group Program layout
 */
export const BuiltinSlots = ['frame', 'material', 'object'] as const;

/**
 * The 'frame' and 'object' slots hold values provided by the engine. Their
 * layout is a fixed contract shared by every program, so that their bind
 * groups can be shared by every draw.
 *
 * @group Program layout
 */
export const EngineSlots = ['frame', 'object'] as const;

/**
 * Name of the uniform block of a slot: `materialUniforms`…
 *
 * @group Program layout
 */
export const uniformBlockName = (slot: string): string => `${slot}Uniforms`;

/**
 * Members of the uniform blocks of the engine slots: a fixed contract.
 *
 * @group Program layout
 */
export const engineUniformBlocks: Readonly<
  Record<
    (typeof EngineSlots)[number],
    readonly { name: string; type: ShaderType }[]
  >
> = {
  frame: [
    { name: 'viewProjection', type: BuiltinTypes.mat4f },
    { name: 'view', type: BuiltinTypes.mat4f },
    { name: 'projection', type: BuiltinTypes.mat4f },
    { name: 'cameraPosition', type: BuiltinTypes.vec3f },
    { name: 'time', type: BuiltinTypes.f32 },
    // Main light. w = 1: point light at xyz; w = 0: directional light, xyz
    // being the direction towards the light. The direction from a point P to
    // the light is normalize(xyz - P × w) in both cases.
    { name: 'lightPosition', type: BuiltinTypes.vec4f },
    { name: 'lightAmbient', type: BuiltinTypes.vec3f },
    { name: 'lightDiffuse', type: BuiltinTypes.vec3f },
    { name: 'lightSpecular', type: BuiltinTypes.vec3f },
    // Constant, linear and quadratic attenuation; (1, 0, 0) for no
    // attenuation.
    { name: 'lightAttenuation', type: BuiltinTypes.vec3f },
  ],
  object: [
    { name: 'world', type: BuiltinTypes.mat4f },
    { name: 'normalMatrix', type: BuiltinTypes.mat3f },
  ],
};

/**
 * Where each 'input.engine' value lives.
 *
 * @group Program layout
 */
export const engineValueLocations: Readonly<
  Record<
    string,
    { readonly slot: (typeof EngineSlots)[number]; readonly member: string }
  >
> = {
  'camera.viewProjection': { slot: 'frame', member: 'viewProjection' },
  'camera.view': { slot: 'frame', member: 'view' },
  'camera.projection': { slot: 'frame', member: 'projection' },
  'camera.position': { slot: 'frame', member: 'cameraPosition' },
  time: { slot: 'frame', member: 'time' },
  'light.position': { slot: 'frame', member: 'lightPosition' },
  'light.ambient': { slot: 'frame', member: 'lightAmbient' },
  'light.diffuse': { slot: 'frame', member: 'lightDiffuse' },
  'light.specular': { slot: 'frame', member: 'lightSpecular' },
  'light.attenuation': { slot: 'frame', member: 'lightAttenuation' },
  'object.world': { slot: 'object', member: 'world' },
  'object.normalMatrix': { slot: 'object', member: 'normalMatrix' },
};

/**
 * The slots in group order: the built-in slots, then the custom ones sorted
 * by name.
 *
 * @group Program layout
 */
export function slotOrder(slots: Iterable<string>): string[] {
  const custom = [...new Set(slots)]
    .filter((slot) => !(BuiltinSlots as readonly string[]).includes(slot))
    .sort();
  return [...BuiltinSlots, ...custom];
}
