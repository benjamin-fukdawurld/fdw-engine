import type {
  GpuSampler,
  GpuSamplerConfiguration,
  RenderBackend,
} from '@fdw/engine-backend';
import { Material, type MaterialValue } from '@fdw/engine-core';
import {
  defineResourceType,
  isAbortError,
  type LoadContext,
  type ResourceLoader,
} from '@fdw/engine-resources';
import {
  MaterialDataType,
  type GraphMaterialData,
  type MaterialData,
  type TextureRef,
} from './data';
import {
  colorSlots,
  materialGraph,
  texturesOf,
  uvTransformRows,
  type TextureSlot,
} from './graphs';
import {
  placeholderTexture,
  sharedSampler,
  TextureType,
  type Texture,
  type TextureOptions,
} from './image/Texture';
import { AssetsConfigService, RenderBackendService } from './services';

export const MaterialType = defineResourceType<Material>('material');

/** The uniform values of a material data, by the names of its graph. */
export function materialFactors(
  data: MaterialData,
): Record<string, MaterialValue> {
  if (data.kind === 'graph') {
    const values: Record<string, MaterialValue> = {};
    for (const [name, value] of Object.entries(data.values))
      if (
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        Array.isArray(value)
      )
        values[name] = value as MaterialValue;
    return values;
  }
  const values: Record<string, MaterialValue> =
    data.kind === 'pbr'
      ? {
          baseColorFactor: [...data.baseColor],
          metallicFactor: data.metallic,
          roughnessFactor: data.roughness,
          emissiveFactor: [...data.emissive],
          ...(data.normalTexture
            ? { normalScale: data.normalTexture.scale }
            : {}),
          ...(data.occlusionTexture
            ? { occlusionStrength: data.occlusionTexture.strength }
            : {}),
          ...(data.alphaMode === 'mask'
            ? { alphaCutoff: data.alphaCutoff }
            : {}),
        }
      : {
          diffuseFactor: [...data.diffuse],
          specularFactor: [...data.specular],
          shininessFactor: data.shininess,
          emissiveFactor: [...data.emissive],
          opacity: data.opacity,
        };
  for (const [slot, ref] of Object.entries(texturesOf(data))) {
    if (!ref.transform) continue;
    const [row0, row1] = uvTransformRows(ref.transform);
    values[`${slot}UvRow0`] = row0;
    values[`${slot}UvRow1`] = row1;
  }
  return values;
}

/** The options of the texture of a slot: its color space and sampler. */
export const textureOptions = (
  slot: TextureSlot,
  ref: TextureRef,
): TextureOptions => ({
  colorSpace: colorSlots.has(slot) ? 'srgb' : 'linear',
  sampler: ref.sampler,
});

// The values a material was made with, to update it in place.
const madeWith = new WeakMap<Material, Record<string, MaterialValue>>();

/**
 * Makes a `Material` from its data in a loader: its graph (shared by the
 * materials with the same features), its factors, and its textures loaded as
 * dependencies of the loader. A texture that fails shows a checker
 * (`onMissing: 'placeholder'`) or fails the material.
 */
export async function realizeMaterial(
  ctx: LoadContext<unknown>,
  data: MaterialData,
): Promise<Material> {
  const config = ctx.service(AssetsConfigService);
  let backend: RenderBackend | undefined;
  if (data.kind === 'graph') {
    const material = await realizeGraphMaterial(data, {
      texture: async (uri, options) => {
        const handle = ctx.use<Texture, TextureOptions>(
          TextureType,
          ctx.resolve(uri),
          options,
        );
        try {
          return await handle.ready;
        } catch (e) {
          if (config.onMissing === 'fail' || isAbortError(e)) throw e;
          config.warn(
            `${ctx.uri}: texture ${uri} replaced by a placeholder (${
              (e as Error).message
            })`,
          );
          return placeholderTexture(ctx.service(RenderBackendService));
        }
      },
      sampler: (configuration) =>
        sharedSampler(ctx.service(RenderBackendService), configuration),
    });
    return material;
  }
  const textures = await Promise.all(
    Object.entries(texturesOf(data)).map(async ([slot, ref]) => {
      const handle = ctx.use<Texture, TextureOptions>(
        TextureType,
        ref.image,
        textureOptions(slot as TextureSlot, ref),
      );
      try {
        return [slot, await handle.ready] as const;
      } catch (e) {
        if (config.onMissing === 'fail' || isAbortError(e)) throw e;
        config.warn(
          `${ctx.uri}: texture ${ref.image} replaced by a placeholder (${
            (e as Error).message
          })`,
        );
        backend ??= ctx.service(RenderBackendService);
        return [slot, placeholderTexture(backend)] as const;
      }
    }),
  );
  const values = materialFactors(data);
  for (const [slot, texture] of textures) {
    values[`${slot}Texture`] = texture.texture;
    values[`${slot}Sampler`] = texture.sampler;
  }
  const material = new Material({
    graph: materialGraph(data),
    values,
    renderState: { alphaMode: data.alphaMode, doubleSided: data.doubleSided },
    label: data.name ?? ctx.uri,
  });
  madeWith.set(material, values);
  return material;
}

const isVector = (value: unknown): value is readonly number[] =>
  Array.isArray(value);

/** How realizeGraphMaterial gets the textures and samplers of the values. */
export interface GraphMaterialResources {
  texture(uri: string, options?: TextureOptions): Promise<Texture>;
  sampler(configuration: GpuSamplerConfiguration): GpuSampler;
}

/**
 * Makes a `Material` from a graph material data: its numbers as they are,
 * its textures and samplers from `resources`. The loader of materials uses
 * it with the store; a scene in memory with its own handles.
 */
export async function realizeGraphMaterial(
  data: GraphMaterialData,
  resources: GraphMaterialResources,
): Promise<Material> {
  const values = materialFactors(data);
  await Promise.all(
    Object.entries(data.values).map(async ([name, value]) => {
      if (typeof value !== 'object' || isVector(value)) return;
      if ('texture' in value) {
        const { texture, ...options } = value;
        // No options: the entry of a texture defined in the store.
        values[name] = (
          await resources.texture(
            texture,
            Object.keys(options).length > 0 ? options : undefined,
          )
        ).texture;
      } else {
        values[name] = resources.sampler(value.sampler);
      }
    }),
  );
  const material = new Material({
    graph: data.graph,
    values,
    features: data.features,
    renderState: data.renderState,
    label: data.name,
  });
  madeWith.set(material, values);
  return material;
}

/**
 * Updates a material in place from another of the same graph and render
 * state: the nodes drawing it see the new values. False when it cannot.
 */
export function updateMaterial(current: Material, next: Material): boolean {
  const values = madeWith.get(next);
  if (
    !values ||
    current.graph !== next.graph ||
    JSON.stringify(current.renderState) !== JSON.stringify(next.renderState)
  ) {
    return false;
  }
  for (const [name, value] of Object.entries(values))
    current.setValue(name, value);
  madeWith.set(current, values);
  return true;
}

/**
 * Materials from their data (`MaterialDataType`, a sub-resource of a model).
 * Their textures are dependencies: a texture reloaded updates the material
 * in place.
 */
export const materialLoader: ResourceLoader<Material> = {
  type: MaterialType,
  async load(ctx) {
    return realizeMaterial(ctx, await ctx.use(MaterialDataType, ctx.uri).ready);
  },
  update: updateMaterial,
};
