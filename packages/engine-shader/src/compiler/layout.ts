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
       * The acceleration structure of a scene, traced by ray.trace: a
       * structure of the GPU, or the buffers of a BVH where the backend
       * traces rays itself (see the rayQuery capability).
       */
      readonly kind: 'acceleration-structure';
      readonly name: string;
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
 * Maximum number of shadow cascades of the cascaded light of a frame.
 *
 * @group Program layout
 */
export const MaxCascades = 4;

/**
 * The shadow cascades of the frame, in the 'frame' uniform block: the
 * light whose `shadow.x` is 2 reads its shadows from them instead of its
 * own tile (one directional light per frame).
 *
 * - cascadeMatrix0..3: world to clip space of each cascade.
 * - cascadeRect0..3: its tile in the shadow atlas, uv offset (xy) and size
 *   (zw).
 * - cascadeSplits: the view depth where each cascade ends (the unused ones
 *   repeat the last).
 * - cascadeOffsets: the normal offset of each cascade, in world units (the
 *   size of its texels).
 *
 * @group Program layout
 */
export const cascadeMembers: readonly { name: string; type: ShaderType }[] = [
  ...Array.from({ length: MaxCascades }, (_, i) => ({
    name: `cascadeMatrix${i}`,
    type: BuiltinTypes.mat4f,
  })),
  ...Array.from({ length: MaxCascades }, (_, i) => ({
    name: `cascadeRect${i}`,
    type: BuiltinTypes.vec4f,
  })),
  { name: 'cascadeSplits', type: BuiltinTypes.vec4f },
  { name: 'cascadeOffsets', type: BuiltinTypes.vec4f },
];

/**
 * The fog of the frame, in the 'frame' uniform block, read by the programs
 * with the 'fog' feature:
 *
 * - fogColor: the color of the fog (rgb, linear) and its density (w), per
 *   unit of distance.
 * - fogHeight: how fast the density falls with the height (x, per unit;
 *   0 for an even fog) above a base height (y).
 *
 * @group Program layout
 */
export const fogMembers: readonly { name: string; type: ShaderType }[] = [
  { name: 'fogColor', type: BuiltinTypes.vec4f },
  { name: 'fogHeight', type: BuiltinTypes.vec4f },
];

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
    // From the clip space back to the world: deferred and screen space
    // passes rebuild positions with it.
    { name: 'inverseViewProjection', type: BuiltinTypes.mat4f },
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
    ...cascadeMembers,
    ...fogMembers,
  ],
  object: [
    { name: 'world', type: BuiltinTypes.mat4f },
    { name: 'normalMatrix', type: BuiltinTypes.mat3f },
  ],
};

/**
 * The members of a row of the object table: the world matrix, then the
 * columns of the normal matrix as vec4, laid out as the 'object' uniform
 * block (std140: the same 112 bytes). The w of the first column holds the
 * identifier of the object, a float exact up to 2^24.
 *
 * @group Program layout
 */
export const objectTableMembers: readonly {
  readonly name: string;
  readonly type: ShaderType;
}[] = [
  { name: 'world', type: BuiltinTypes.mat4f },
  { name: 'normalColumn0', type: BuiltinTypes.vec4f },
  { name: 'normalColumn1', type: BuiltinTypes.vec4f },
  { name: 'normalColumn2', type: BuiltinTypes.vec4f },
];

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
  'camera.inverseViewProjection': {
    slot: 'frame',
    member: 'inverseViewProjection',
  },
  'camera.position': { slot: 'frame', member: 'cameraPosition' },
  time: { slot: 'frame', member: 'time' },
  exposure: { slot: 'frame', member: 'exposure' },
  'object.world': { slot: 'object', member: 'world' },
  'object.normalMatrix': { slot: 'object', member: 'normalMatrix' },
  ...Object.fromEntries(
    cascadeMembers.map(({ name }) => [
      `shadow.${name}`,
      { slot: 'frame', member: name },
    ]),
  ),
  'fog.color': { slot: 'frame', member: 'fogColor' },
  'fog.height': { slot: 'frame', member: 'fogHeight' },
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
  // The scene traced by rays, and what the functions of the hits read (see
  // rayInstanceMembers).
  scene: { kind: 'acceleration-structure', name: 'scene' },
  rayInstances: {
    kind: 'storage-buffer',
    name: 'rayInstances',
    type: arrayType(BuiltinTypes.vec4f),
    access: 'read',
  },
  rayIndices: {
    kind: 'storage-buffer',
    name: 'rayIndices',
    type: arrayType(BuiltinTypes.u32),
    access: 'read',
  },
  rayVertices: {
    kind: 'storage-buffer',
    name: 'rayVertices',
    type: arrayType(BuiltinTypes.vec4f),
    access: 'read',
  },
};

/**
 * The data of the scene traced by rays, in the storage buffers of the
 * 'frame' slot read by the functions of the hits (ray.hitPosition…), the
 * same on every backend:
 *
 * - rayInstances, RayInstanceVec4s vec4 per instance of the acceleration
 *   structure: the object to world matrix by rows (3 vec4: x, y, z of a
 *   point p are dot(row, vec4(p, 1))), the columns of the normal matrix
 *   (3 vec4), then the bits of four u32: the first index of its mesh in
 *   rayIndices, its material (the index of its material in the traced
 *   scene), the identifier of its object, its flags (RayInstanceFlags);
 *   then a vec4 of the application (0 by default).
 * - rayIndices: the vertices of the triangles, 3 per triangle, indices of
 *   rayVertices.
 * - rayVertices, RayVertexVec4s vec4 per vertex: the position (object
 *   space) and u, the normal and v, the tangent (xyz, w the handedness).
 *
 * @group Program layout
 */
export const RayInstanceVec4s = 8;
/** @see RayInstanceVec4s */
export const RayVertexVec4s = 3;

/**
 * The flags of an instance of the traced scene (the w of its 7th vec4).
 *
 * @group Program layout
 */
export const RayInstanceFlags = {
  /** Its material is seen from both sides. */
  doubleSided: 1,
  /** Its material is transparent or masked: see its alpha. */
  alpha: 2,
} as const;

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
