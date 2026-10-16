import type { RenderBackend } from '@fdw/engine-backend';
import { Material, type MaterialValue } from '@fdw/engine-core';
import {
  defineResourceType,
  isAbortError,
  type LoadContext,
  type ResourceLoader,
} from '@fdw/engine-resources';
import { MaterialDataType, type MaterialData, type TextureRef } from './data';
import {
  colorSlots,
  materialGraph,
  texturesOf,
  uvTransformRows,
  type TextureSlot,
} from './graphs';
import {
  placeholderTexture,
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
