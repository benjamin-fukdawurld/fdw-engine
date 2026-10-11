import {
  ArrayType,
  arrayType,
  BuiltinTypes,
  ShaderType,
  TextureType,
} from '../types/ShaderType';

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
      /** A storage buffer: a runtime-sized array. */
      readonly kind: 'storage-buffer';
      readonly name: string;
      readonly type: ArrayType;
      /** Written by compute stages only. */
      readonly access: 'read' | 'read-write';
    }
  | {
      readonly kind: 'sampler';
      readonly name: string;
      readonly comparison: boolean;
    }
  | {
      /**
       * The table of the objects drawn: a row per object (the members), and
       * the row of each instance drawn. An instance reads the row
       * instances[firstInstance + instance] (see input.object). Each backend
       * chooses the memory: storage buffers, data textures.
       */
      readonly kind: 'object-table';
      readonly name: string;
      readonly members: readonly {
        readonly name: string;
        readonly type: ShaderType;
      }[];
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
 * Name of the object table, in the 'object' slot of the backends with the
 * objectTable capability.
 *
 * @group Program layout
 */
export const ObjectTableName = 'objects';

/**
 * Name of the uniform block of a slot: `materialUniforms`…
 *
 * @group Program layout
 */
export const uniformBlockName = (slot: string): string => `${slot}Uniforms`;

/**
 * Maximum number of lights of a frame: the size of the light arrays of the
 * 'frame' uniform block.
 *
 * @group Program layout
 */
export const MaxLights = 16;

/**
 * The lights of the frame, in the 'frame' uniform block: one array of vec4
 * per property, indexed by light. Each output of the 'light.current' node
 * reads the components of one of them.
 *
 * - position: xyz, and w = 1 for a point or spot light, 0 for a directional
 *   light (xyz is then the direction towards the light). The direction from
 *   a point P to the light is normalize(xyz - P × w) in both cases.
 * - ambient, diffuse, specular: rgb colors.
 * - attenuation: constant, linear and quadratic factors; (1, 0, 0) for none.
 * - spotDirection: direction the spot shines in.
 * - spotCone: cosines of the inner and outer angles of the cone; (-1, -2)
 *   lights every direction.
 * - shadow: x = 1 when the light has a tile in the shadow atlas (0
 *   otherwise), y = depth bias, z = normal offset (world units per unit of
 *   clip w: per unit of distance for a spot), w = size of a texel of the
 *   atlas in uv.
 * - shadowRect: tile of the light in the shadow atlas, uv offset (xy) and
 *   size (zw).
 * - shadowMatrix: world to clip space of the light, for its shadow map
 *   (the only matrix: one mat4 per light instead of a vec4).
 *
 * @group Program layout
 */
export const lightMembers: Readonly<
  Record<string, { readonly member: string; readonly type: ShaderType }>
> = {
  position: { member: 'lightPositions', type: BuiltinTypes.vec4f },
  ambient: { member: 'lightAmbients', type: BuiltinTypes.vec3f },
  diffuse: { member: 'lightDiffuses', type: BuiltinTypes.vec3f },
  specular: { member: 'lightSpeculars', type: BuiltinTypes.vec3f },
  attenuation: { member: 'lightAttenuations', type: BuiltinTypes.vec3f },
  spotDirection: { member: 'lightSpotDirections', type: BuiltinTypes.vec3f },
  spotCone: { member: 'lightSpotCones', type: BuiltinTypes.vec2f },
  shadow: { member: 'lightShadows', type: BuiltinTypes.vec4f },
  shadowRect: { member: 'lightShadowRects', type: BuiltinTypes.vec4f },
  shadowMatrix: { member: 'lightShadowMatrices', type: BuiltinTypes.mat4f },
};

/**
 * The array of the frame uniform block holding a light property: vec4 per
 * light, or mat4 for matrices.
 *
 * @group Program layout
 */
export const lightArrayType = (type: ShaderType): ArrayType =>
  arrayType(type.kind === 'matrix' ? type : BuiltinTypes.vec4f, MaxLights);

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
    // Multiplies the linear color before the tone mapping.
    { name: 'exposure', type: BuiltinTypes.f32 },
    // Number of lights in the arrays below (see lightMembers).
    { name: 'lightCount', type: BuiltinTypes.u32 },
    ...Object.values(lightMembers).map(({ member, type }) => ({
      name: member,
      type: lightArrayType(type),
    })),
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
  exposure: { slot: 'frame', member: 'exposure' },
  'object.world': { slot: 'object', member: 'world' },
  'object.normalMatrix': { slot: 'object', member: 'normalMatrix' },
};

/**
 * Resources of the 'frame' slot provided by the engine and read with
 * 'input.engine': the shadow atlas of the lights (a depth texture) and its
 * comparison sampler. Only the programs reading them have them, after the
 * uniform block of the slot.
 *
 * @group Program layout
 */
export const engineResources: Readonly<Record<string, LogicalBinding>> = {
  shadowMap: {
    kind: 'texture',
    name: 'shadowMap',
    type: BuiltinTypes.depthTexture2d,
  },
  shadowSampler: { kind: 'sampler', name: 'shadowSampler', comparison: true },
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
