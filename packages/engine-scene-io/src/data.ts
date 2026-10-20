import type { MaterialData, MeshData } from '@fdw/engine-assets';
import { defineResourceType, type ResourceUri } from '@fdw/engine-resources';

// The pivot of the formats: a scene on the CPU, without the engine objects.
// Importers make it, exporters write it; captureScene and instantiateScene
// link it to a Scene.

export type Vec3Tuple = readonly [number, number, number];
export type QuatTuple = readonly [number, number, number, number];

/**
 * A resource used by a scene: its URI (relative to the scene, or with a
 * scheme), or its URI and the options it is loaded with. `#mesh/2` and
 * `#material/0` are the meshes and materials written with the scene.
 */
export type ResourceRef =
  ResourceUri | { readonly uri: ResourceUri; readonly options: unknown };

/** The values of a component, with the version of its codec. */
export interface ComponentData {
  readonly version: number;
  readonly data: unknown;
}

/** What a node is: the fields shared by the nodes and the overrides. */
export interface NodeFields {
  readonly name?: string;
  readonly position?: Vec3Tuple;
  readonly rotation?: QuatTuple;
  readonly scale?: Vec3Tuple;
  /** True by default. */
  readonly visible?: boolean;
  readonly static?: boolean;
  readonly occluder?: boolean;
  /** All by default. */
  readonly layers?: number;
  /** By the name of the component. */
  readonly components?: Readonly<Record<string, ComponentData>>;
}

/**
 * A change of a node of an instance: found by its path from the root of
 * the instance (the names of the nodes, `Body/Arm`; `#2` for the third
 * child when names repeat), its fields replaced, or removed.
 */
export interface OverrideData extends Omit<NodeFields, 'name'> {
  readonly path: string;
  readonly removed?: boolean;
}

/**
 * A node made from another resource: a model (glTF, OBJ) or a scene, with
 * its changes. The fields of the node place its root.
 */
export interface InstanceData {
  readonly model?: ResourceRef;
  readonly scene?: ResourceRef;
  /** Models: whether the meshes cast shadows. True by default. */
  readonly castShadow?: boolean;
  /** Models: whether the lights of the model are added. True by default. */
  readonly lights?: boolean;
  readonly overrides?: readonly OverrideData[];
}

export interface SceneNodeData extends NodeFields {
  /** The index of the parent in the entities of the scene; none: at the root. */
  readonly parent?: number;
  /** Under a node of the instance `parent`: its path (see OverrideData). */
  readonly parentPath?: string;
  readonly instance?: InstanceData;
}

/**
 * Many leaf nodes alike (`Scene.createBatch`): the same parent, name,
 * flags, mesh and material, a transform each in flat arrays. Their other
 * components are columns of a value per entity (null for none).
 */
export interface SceneBatchData {
  readonly parent?: number;
  readonly name?: string;
  readonly count: number;
  /** x y z per entity. */
  readonly positions: Float32Array;
  /** x y z w per entity. */
  readonly rotations: Float32Array;
  /** x y z per entity. */
  readonly scales: Float32Array;
  readonly visible?: boolean;
  readonly static?: boolean;
  readonly occluder?: boolean;
  readonly layers?: number;
  readonly mesh?: ResourceRef;
  readonly material?: ResourceRef;
  readonly castShadow?: boolean;
  readonly components?: Readonly<
    Record<
      string,
      { readonly version: number; readonly data: readonly unknown[] }
    >
  >;
}

/**
 * A scene on the CPU. Its entities are numbered for the references
 * between them (a parent, the levels of detail): the nodes first, then the
 * entities of each batch in turn. Component data may hold typed arrays
 * (a heightfield): the formats write them as binary.
 */
export interface SceneData {
  readonly name?: string;
  /** Parents before their children. */
  readonly nodes: readonly SceneNodeData[];
  readonly batches: readonly SceneBatchData[];
  /** The meshes written with the scene: `#mesh/<index>`. */
  readonly meshes: readonly MeshData[];
  /** The materials written with the scene: `#material/<index>`. */
  readonly materials: readonly MaterialData[];
}

export const SceneDataType = defineResourceType<SceneData>('scene-data');

/** The number of entities of a scene: its nodes, and those of its batches. */
export const entityCount = (data: SceneData): number =>
  data.batches.reduce((sum, batch) => sum + batch.count, data.nodes.length);

/** The URI of a reference. */
export const refUri = (ref: ResourceRef): ResourceUri =>
  typeof ref === 'string' ? ref : ref.uri;

/** The options of a reference. */
export const refOptions = (ref: ResourceRef): unknown =>
  typeof ref === 'string' ? undefined : ref.options;

/** A scene without anything. */
export const emptyScene = (name?: string): SceneData => ({
  name,
  nodes: [],
  batches: [],
  meshes: [],
  materials: [],
});
