import type { Material, Mesh } from '@fdw/engine-core';
import { defineResourceType, type ResourceLoader } from '@fdw/engine-resources';
import { MaterialDataType, ModelDataType, type ModelData } from './data';
import { MaterialType } from './materials';
import { MeshType, type MeshOptions } from './meshes';

/** A primitive realized: drawn with `node.setMesh(mesh, material)`. */
export interface ModelPrimitive {
  readonly mesh: Mesh;
  readonly material: Material;
}

/**
 * A model realized: its data, and the meshes and materials of its
 * primitives, shared by all its instances (drawn in one call each by the
 * instancing). A reload updates it in place.
 */
export class Model {
  private _data: ModelData;
  private _meshes: readonly (readonly ModelPrimitive[])[];
  private _version = 0;

  constructor(data: ModelData, meshes: readonly (readonly ModelPrimitive[])[]) {
    this._data = data;
    this._meshes = meshes;
  }

  get data(): ModelData {
    return this._data;
  }

  /** The primitives of each mesh of the data, in its order. */
  get meshes(): readonly (readonly ModelPrimitive[])[] {
    return this._meshes;
  }

  /** Incremented when a reload changes it. */
  get version(): number {
    return this._version;
  }

  /** Takes the content of another model: a reload in place. */
  assign(other: Model): this {
    this._data = other._data;
    this._meshes = other._meshes;
    this._version++;
    return this;
  }
}

export const ModelType = defineResourceType<Model>('model');

/**
 * Models from their data (`ModelDataType`, made by a format loader:
 * `installGltf`, `installObj`). Meshes and materials are loaded as
 * sub-resources of the URI, so two models never duplicate them, and a mesh
 * whose material has a normal map gets tangents.
 */
export const modelLoader: ResourceLoader<Model> = {
  type: ModelType,
  async load(ctx) {
    const data = await ctx.use(ModelDataType, ctx.uri).ready;
    const sub = (id: string) => ctx.resolve(`#${id}`);
    const materials = new Map<string, Promise<Material>>();
    const material = (id: string) => {
      let promise = materials.get(id);
      if (!promise)
        materials.set(id, (promise = ctx.use(MaterialType, sub(id)).ready));
      return promise;
    };
    const tangents = async (id: string) => {
      const data = await ctx.use(MaterialDataType, sub(id)).ready;
      return data.normalTexture !== undefined;
    };
    const meshes = await Promise.all(
      data.meshes.map((m) =>
        Promise.all(
          m.primitives.map(async (p) => {
            const options: MeshOptions = (await tangents(p.material))
              ? { tangents: true }
              : {};
            const [mesh, mat] = await Promise.all([
              ctx.use<Mesh, MeshOptions>(MeshType, sub(p.mesh), options).ready,
              material(p.material),
            ]);
            return { mesh, material: mat };
          })
        )
      )
    );
    return new Model(data, meshes);
  },
  update(current, next) {
    current.assign(next);
    return true;
  },
};
