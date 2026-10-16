import type { PbrMaterialData, TextureRef } from '@fdw/engine-assets';
import type {
  GpuSamplerConfiguration,
  GpuTextureFilterMode,
  GpuTextureWrapMode,
} from '@fdw/engine-backend';
import type { GltfMaterial, GltfSampler, GltfTextureInfo } from './types';

const wrapModes: Readonly<Record<number, GpuTextureWrapMode>> = {
  33071: 'clamp-to-edge',
  33648: 'mirror-repeat',
  10497: 'repeat',
};

const filters: Readonly<Record<number, GpuTextureFilterMode>> = {
  9728: 'nearest',
  9729: 'linear',
};

// The minifying filters with mipmaps: [minFilter, mipmapFilter].
const mipmapFilters: Readonly<
  Record<number, readonly [GpuTextureFilterMode, GpuTextureFilterMode]>
> = {
  9984: ['nearest', 'nearest'],
  9985: ['linear', 'nearest'],
  9986: ['nearest', 'linear'],
  9987: ['linear', 'linear'],
};

/**
 * The sampler of a texture, from the constants of OpenGL glTF uses. Without
 * a sampler or a filter, it repeats and filters linearly, mipmaps included.
 */
export function samplerConfiguration(
  sampler: GltfSampler | undefined
): GpuSamplerConfiguration {
  const min = sampler?.minFilter;
  const [minFilter, mipmapFilter] =
    min === undefined
      ? ['linear', 'linear']
      : mipmapFilters[min] ?? [filters[min] ?? 'linear', undefined];
  return {
    wrapModeS: wrapModes[sampler?.wrapS ?? 10497] ?? 'repeat',
    wrapModeT: wrapModes[sampler?.wrapT ?? 10497] ?? 'repeat',
    magFilter: filters[sampler?.magFilter ?? 9729] ?? 'linear',
    minFilter,
    ...(mipmapFilter ? { mipmapFilter } : {}),
  };
}

/** Resolves a texture of a material: undefined when it has no usable image. */
export type TextureResolver = (
  info: GltfTextureInfo
) => Promise<TextureRef | undefined>;

/**
 * The data of a material, before its extensions: the factors of glTF (its
 * defaults: a white, metallic and rough surface), its textures.
 */
export async function pbrMaterialData(
  material: GltfMaterial,
  texture: TextureResolver,
  vertexColors: boolean
): Promise<PbrMaterialData> {
  const pbr = material.pbrMetallicRoughness ?? {};
  const optional = (info: GltfTextureInfo | undefined) =>
    info ? texture(info) : Promise.resolve(undefined);
  const [
    baseColorTexture,
    metallicRoughnessTexture,
    normal,
    occlusion,
    emissiveTexture,
  ] = await Promise.all([
    optional(pbr.baseColorTexture),
    optional(pbr.metallicRoughnessTexture),
    optional(material.normalTexture),
    optional(material.occlusionTexture),
    optional(material.emissiveTexture),
  ]);
  const alphaMode =
    material.alphaMode === 'MASK'
      ? 'mask'
      : material.alphaMode === 'BLEND'
      ? 'blend'
      : 'opaque';
  return {
    kind: 'pbr',
    ...(material.name !== undefined ? { name: material.name } : {}),
    baseColor: pbr.baseColorFactor ?? [1, 1, 1, 1],
    ...(baseColorTexture ? { baseColorTexture } : {}),
    metallic: pbr.metallicFactor ?? 1,
    roughness: pbr.roughnessFactor ?? 1,
    ...(metallicRoughnessTexture ? { metallicRoughnessTexture } : {}),
    ...(normal
      ? {
          normalTexture: {
            ...normal,
            scale: material.normalTexture?.scale ?? 1,
          },
        }
      : {}),
    ...(occlusion
      ? {
          occlusionTexture: {
            ...occlusion,
            strength: material.occlusionTexture?.strength ?? 1,
          },
        }
      : {}),
    emissive: material.emissiveFactor ?? [0, 0, 0],
    ...(emissiveTexture ? { emissiveTexture } : {}),
    alphaMode,
    alphaCutoff: material.alphaCutoff ?? 0.5,
    doubleSided: material.doubleSided ?? false,
    ...(vertexColors ? { vertexColors } : {}),
  };
}
