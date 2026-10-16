import type {
  GpuSamplerConfiguration,
  MeshDescription,
} from '@fdw/engine-backend';
import type { IndexData } from '@fdw/engine-core';
import { defineResourceType, type ResourceUri } from '@fdw/engine-resources';

// The data level: what the format loaders produce, on the CPU, without the
// backend. The realizations (meshes.ts, materials.ts, models.ts) make the
// objects of the engine from it.

export type Vec3Tuple = readonly [number, number, number];
export type Vec4Tuple = readonly [number, number, number, number];

// --- Meshes -----------------------------------------------------------------

/**
 * The geometry of a primitive, in the layout of a `Mesh`. Attributes follow
 * the naming of multiple sets: `uv`, `uv1`, `uv2`…, `color`, `color1`,
 * `joints`, `weights`, `tangent`.
 */
export interface MeshData {
  readonly name?: string;
  readonly description: MeshDescription;
  readonly vertices: readonly ArrayBufferView<ArrayBuffer>[];
  readonly indices?: IndexData;
}

export const MeshDataType = defineResourceType<MeshData>('mesh-data');

// --- Materials ----------------------------------------------------------------

/** The 2 × 3 transform of the uv a texture is read with (`KHR_texture_transform`). */
export interface UvTransform {
  readonly offset: readonly [number, number];
  /** Radians, as in glTF. */
  readonly rotation: number;
  readonly scale: readonly [number, number];
}

/** A texture of a material: an image, how it is read. */
export interface TextureRef {
  /**
   * Serializable: `textures/bark.png`, or `model.glb#image/0` for an image
   * embedded in its model (its bytes are a sub-resource of the model).
   */
  readonly image: ResourceUri;
  /** The uv set: 0 reads `uv`, 1 reads `uv1`… */
  readonly texCoord: number;
  readonly sampler: GpuSamplerConfiguration;
  readonly transform?: UvTransform;
}

/** Metallic / roughness: the model of glTF, realized with the `pbr` shading model. */
export interface PbrMaterialData {
  readonly kind: 'pbr';
  readonly name?: string;
  /** Linear RGBA. */
  readonly baseColor: Vec4Tuple;
  readonly baseColorTexture?: TextureRef;
  readonly metallic: number;
  readonly roughness: number;
  /** Roughness in g, metallic in b. */
  readonly metallicRoughnessTexture?: TextureRef;
  readonly normalTexture?: TextureRef & { readonly scale: number };
  readonly occlusionTexture?: TextureRef & { readonly strength: number };
  /** Linear RGB, already multiplied by `KHR_materials_emissive_strength`. */
  readonly emissive: Vec3Tuple;
  readonly emissiveTexture?: TextureRef;
  readonly alphaMode: 'opaque' | 'mask' | 'blend';
  readonly alphaCutoff: number;
  readonly doubleSided: boolean;
  /** `KHR_materials_unlit`: the base color only. */
  readonly unlit?: boolean;
  /** Multiplies the base color by the vertex colors (`color`), on the meshes that have some. */
  readonly vertexColors?: boolean;
}

/** Diffuse / specular: the model of the MTL files of OBJ, realized with `phong`. */
export interface PhongMaterialData {
  readonly kind: 'phong';
  readonly name?: string;
  readonly diffuse: Vec3Tuple;
  readonly diffuseTexture?: TextureRef;
  readonly specular: Vec3Tuple;
  readonly specularTexture?: TextureRef;
  readonly shininess: number;
  /** Multiplies `shininess` by its red channel. */
  readonly shininessTexture?: TextureRef;
  readonly emissive: Vec3Tuple;
  readonly emissiveTexture?: TextureRef;
  readonly normalTexture?: TextureRef;
  readonly opacity: number;
  readonly alphaMode: 'opaque' | 'mask' | 'blend';
  readonly doubleSided: boolean;
}

export type MaterialData = PbrMaterialData | PhongMaterialData;

export const MaterialDataType =
  defineResourceType<MaterialData>('material-data');

/** The material of the primitives without one: white, rough, dielectric. */
export const defaultPbrMaterial: PbrMaterialData = {
  kind: 'pbr',
  name: 'default',
  baseColor: [1, 1, 1, 1],
  metallic: 0,
  roughness: 1,
  emissive: [0, 0, 0],
  alphaMode: 'opaque',
  alphaCutoff: 0.5,
  doubleSided: false,
};

// --- Models -------------------------------------------------------------------

/** A primitive of a mesh: the ids of its sub-resources in the model (`mesh/Body/0`, `material/Bark`). */
export interface PrimitiveData {
  readonly mesh: string;
  readonly material: string;
}

export interface ModelMeshData {
  readonly name?: string;
  readonly primitives: readonly PrimitiveData[];
}

export interface ModelNodeData {
  readonly name?: string;
  readonly translation?: Vec3Tuple;
  /** A quaternion, x y z w. */
  readonly rotation?: Vec4Tuple;
  readonly scale?: Vec3Tuple;
  readonly children: readonly number[];
  /** In `ModelData.meshes`. */
  readonly mesh?: number;
  readonly skin?: number;
  readonly camera?: number;
  readonly light?: number;
}

/** The joints of a skin, for the animation of P6: read, not played. */
export interface SkinData {
  readonly name?: string;
  readonly joints: readonly number[];
  /** A 4 × 4 matrix per joint, column-major. */
  readonly inverseBindMatrices?: Float32Array<ArrayBuffer>;
  readonly skeleton?: number;
}

export interface AnimationChannelData {
  readonly node: number;
  readonly path: 'translation' | 'rotation' | 'scale' | 'weights';
  readonly interpolation: 'LINEAR' | 'STEP' | 'CUBICSPLINE';
  /** Seconds. */
  readonly times: Float32Array<ArrayBuffer>;
  /** The values at each time, tangents included for `CUBICSPLINE`. */
  readonly values: Float32Array<ArrayBuffer>;
}

/** An animation, for P6: read, not played. */
export interface AnimationClipData {
  readonly name?: string;
  readonly duration: number;
  readonly channels: readonly AnimationChannelData[];
}

export type CameraData =
  | {
      readonly type: 'perspective';
      readonly name?: string;
      /** Radians. */
      readonly yfov: number;
      readonly aspectRatio?: number;
      readonly znear: number;
      readonly zfar?: number;
    }
  | {
      readonly type: 'orthographic';
      readonly name?: string;
      readonly xmag: number;
      readonly ymag: number;
      readonly znear: number;
      readonly zfar: number;
    };

/** `KHR_lights_punctual`: shining along the -z axis of its node. */
export interface LightData {
  readonly type: 'directional' | 'point' | 'spot';
  readonly name?: string;
  readonly color: Vec3Tuple;
  readonly intensity: number;
  readonly range?: number;
  /** Radians. */
  readonly innerConeAngle?: number;
  readonly outerConeAngle?: number;
}

/**
 * A model on the CPU: a hierarchy of nodes, its meshes, skins, animations,
 * cameras and lights. Its meshes and materials are sub-resources of its URI
 * (`oak.glb#mesh/Trunk/0`), provided by the loader as `MeshDataType` and
 * `MaterialDataType`.
 */
export interface ModelData {
  readonly name?: string;
  readonly nodes: readonly ModelNodeData[];
  /** The nodes without parent, in order. */
  readonly roots: readonly number[];
  readonly meshes: readonly ModelMeshData[];
  readonly skins: readonly SkinData[];
  readonly animations: readonly AnimationClipData[];
  readonly cameras: readonly CameraData[];
  readonly lights: readonly LightData[];
}

export const ModelDataType = defineResourceType<ModelData>('model-data');

/** A model of a single node and mesh. */
export const singleMeshModel = (
  name: string,
  primitives: readonly PrimitiveData[],
): ModelData => ({
  name,
  nodes: [{ name, children: [], mesh: 0 }],
  roots: [0],
  meshes: [{ name, primitives }],
  skins: [],
  animations: [],
  cameras: [],
  lights: [],
});

/** The bytes of a mesh on the CPU, for the budget of the cache. */
export const meshDataSize = (mesh: MeshData): number =>
  mesh.vertices.reduce((sum, v) => sum + v.byteLength, 0) +
  (mesh.indices?.byteLength ?? 0);
