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
 * The lights of the frame, in the 'lights' storage buffer of the 'frame'
 * slot (the light pool): LightVec4s vec4 per light, the light i from the
 * vec4 i × LightVec4s. Each output of the 'light.current' node reads the
 * components of one of them, at its offset (in vec4).
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
 *   (4 vec4, its columns).
 *
 * The pool has no fixed size: the renderer writes every light of the frame.
 *
 * @group Program layout
 */
export const lightMembers: Readonly<
  Record<string, { readonly offset: number; readonly type: ShaderType }>
> = {
  position: { offset: 0, type: BuiltinTypes.vec4f },
  ambient: { offset: 1, type: BuiltinTypes.vec3f },
  diffuse: { offset: 2, type: BuiltinTypes.vec3f },
  specular: { offset: 3, type: BuiltinTypes.vec3f },
  attenuation: { offset: 4, type: BuiltinTypes.vec3f },
  spotDirection: { offset: 5, type: BuiltinTypes.vec3f },
  spotCone: { offset: 6, type: BuiltinTypes.vec2f },
  shadow: { offset: 7, type: BuiltinTypes.vec4f },
  shadowRect: { offset: 8, type: BuiltinTypes.vec4f },
  shadowMatrix: { offset: 9, type: BuiltinTypes.mat4f },
};

/**
 * The vec4 of a light in the light pool (see lightMembers).
 *
 * @group Program layout
 */
export const LightVec4s = 13;

/**
 * The light clusters of the frame (clustered forward shading): the view is
 * cut in tiles of the screen (x, y) and in slices of the view depth (z),
 * each cluster listing the lights that reach it. A `light.sum` given the
 * position of the point (and the 'lightClusters' feature) loops over the
 * global lights, then over those of the cluster of the point only.
 *
 * In the 'frame' uniform block:
 * - lightClusters: the tiles along x and y, the slices, and the number of
 *   global lights (w), the first ones of the pool: the directional lights
 *   and those without range, which reach every cluster.
 * - lightClusterDepth: the slice of a view depth d is floor(log2(d) × x +
 *   y), clamped to the slices.
 *
 * The 'lightGrid' storage buffer (u32): two per cluster, the first index
 * of its list and its count, then the lists, indices of lights in the
 * pool. The cluster of tile (x, y) (from the bottom left of the clip space)
 * and slice z is (z × tiles y + y) × tiles x + x.
 *
 * @group Program layout
 */
export const lightClusterMembers: readonly {
  name: string;
  type: ShaderType;
}[] = [
  { name: 'lightClusters', type: BuiltinTypes.vec4f },
  { name: 'lightClusterDepth', type: BuiltinTypes.vec4f },
];

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
 * The prefiltered levels of the environment: the radiance seen by
 * surfaces of roughness 0, 1 / (EnvironmentLevels - 1)… 1 (see
 * environmentMembers).
 *
 * @group Program layout
 */
export const EnvironmentLevels = 6;

/**
 * The tiles of the atlas of the environment, along x and y (see
 * environmentMembers).
 *
 * @group Program layout
 */
export const EnvironmentTiles = { x: 4, y: 2 } as const;

/**
 * The environment of the frame (image-based lighting), read by the
 * programs with the 'environment' feature (the environment.* functions).
 * Its light is prefiltered in an atlas, the 'environmentMap' engine
 * resource (a 2d float texture, linear filtered by 'environmentSampler'),
 * of EnvironmentTiles tiles of (size + 2)² texels: each tile has a border
 * of one texel, so that the bilinear filter does not reach the next one.
 * Tile k is at column k % 4, row floor(k / 4) (from the top left):
 *
 * - tiles 0 to EnvironmentLevels - 1: the radiance a surface of roughness
 *   k / (EnvironmentLevels - 1) reflects in a direction (GGX, prefiltered
 *   with N = V = R), an octahedral map of the directions;
 * - tile EnvironmentLevels: the irradiance of a normal divided by π (the
 *   light a white lambertian surface reflects), an octahedral map;
 * - tile EnvironmentLevels + 1: the scale and bias of F0 of the split sum
 *   (rg, Karis 2013), by N·V (u) and roughness (v).
 *
 * In the 'frame' uniform block:
 * - environment: the size of a tile in texels without its border (x), the
 *   size of a texel of the atlas in uv (y, z), the intensity (w; 0 without
 *   environment).
 *
 * @group Program layout
 */
export const environmentMembers: readonly { name: string; type: ShaderType }[] =
  [{ name: 'environment', type: BuiltinTypes.vec4f }];

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
    // Number of lights in the light pool (see lightMembers).
    { name: 'lightCount', type: BuiltinTypes.u32 },
    ...lightClusterMembers,
    ...cascadeMembers,
    ...fogMembers,
    ...environmentMembers,
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
  lightCount: { slot: 'frame', member: 'lightCount' },
  environment: { slot: 'frame', member: 'environment' },
  ...Object.fromEntries(
    lightClusterMembers.map(({ name }) => [
      name,
      { slot: 'frame', member: name },
    ]),
  ),
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
  // The light pool and the light clusters (see lightMembers,
  // lightClusterMembers): bound to the programs summing lights.
  lights: {
    kind: 'storage-buffer',
    name: 'lights',
    type: arrayType(BuiltinTypes.vec4f),
    access: 'read',
  },
  lightGrid: {
    kind: 'storage-buffer',
    name: 'lightGrid',
    type: arrayType(BuiltinTypes.u32),
    access: 'read',
  },
  // The prefiltered environment (see environmentMembers).
  environmentMap: {
    kind: 'texture',
    name: 'environmentMap',
    type: BuiltinTypes.texture2d,
  },
  environmentSampler: {
    kind: 'sampler',
    name: 'environmentSampler',
    comparison: false,
  },
  // The scene traced by rays, and what the functions of the hits read (see
  // rayInstanceMembers).
  scene: { kind: 'acceleration-structure', name: 'scene' },
  rayInstances: {
    kind: 'storage-buffer',
    name: 'rayInstances',
    type: arrayType(BuiltinTypes.vec4f),
    access: 'read',
  },
  rayGeometry: {
    kind: 'storage-buffer',
    name: 'rayGeometry',
    type: arrayType(BuiltinTypes.vec4f),
    access: 'read',
  },
};

/**
 * The data of the scene traced by rays, in two storage buffers of vec4 of
 * the 'frame' slot read by the functions of the hits (ray.hitPosition…),
 * the same on every backend (two buffers: with the two of a structure in
 * software, and those of a pass, a program stays within the 8 storage
 * buffers WebGPU guarantees):
 *
 * - rayInstances, RayInstanceVec4s vec4 per instance of the acceleration
 *   structure: the object to world matrix by rows (3 vec4: x, y, z of a
 *   point p are dot(row, vec4(p, 1))), the columns of the normal matrix
 *   (3 vec4), then the bits of four u32: the vec4 of the first triangle of
 *   its mesh in rayGeometry, its material (the index of its material in
 *   the traced scene), the identifier of its object, its flags
 *   (RayInstanceFlags); then a vec4 of the application (0 by default).
 * - rayGeometry: the triangles of the meshes, a vec4 each (the bits of
 *   the u32 offsets of the records of its three vertices, then 0), and the
 *   records of their vertices, RayVertexVec4s vec4 each: the position
 *   (object space) and u, the normal and v, the tangent (xyz, w the
 *   handedness).
 *
 * @group Program layout
 */
export const RayInstanceVec4s = 8;
/** @see RayInstanceVec4s */
export const RayVertexVec4s = 3;

/**
 * The bits of the masks of the instances of the traced scene: the rays of
 * the camera and of the reflections see the visible ones; the shadow rays
 * the shadow casters only (transparent materials and items with
 * castShadow false are not).
 *
 * @group Program layout
 */
export const RayMasks = {
  visible: 1,
  shadow: 2,
} as const;

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
  /**
   * Its material is masked, and its mask is in rayGeometry: the rays
   * traced with alphaTest go through where it is cut (the foliage). The
   * bits 8 to 31 of the flags are then the vec4 of the mask in
   * rayGeometry (see RayAlphaMaskSize).
   */
  alphaTest: 4,
} as const;

/**
 * The alpha masks of the traced scene: per masked material, its alpha cut
 * at its cutoff in RayAlphaMaskSize × RayAlphaMaskSize bits over the
 * [0, 1] square of its uv (repeated), rows of increasing v, 32 bits per
 * u32, in RayAlphaMaskVec4s vec4 of rayGeometry. A bit is 1 where the
 * material is kept. Read by the traversals of the rays traced with
 * alphaTest at the texel nearest to the uv of the point hit.
 *
 * @group Program layout
 */
export const RayAlphaMaskSize = 256;
/** @see RayAlphaMaskSize */
export const RayAlphaMaskVec4s = (RayAlphaMaskSize * RayAlphaMaskSize) / 128;

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
