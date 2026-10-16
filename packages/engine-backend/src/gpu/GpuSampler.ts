import type { CompareFunction } from '../render/types';

export const GpuTextureWrapModeNames = [
  'clamp-to-edge',
  'repeat',
  'mirror-repeat',
] as const;
export type GpuTextureWrapModeName = (typeof GpuTextureWrapModeNames)[number];
export type GpuTextureWrapMode = GpuTextureWrapModeName | (string & {});

export const GpuTextureFilterModeNames = ['nearest', 'linear'] as const;
export type GpuTextureFilterModeName =
  (typeof GpuTextureFilterModeNames)[number];
export type GpuTextureFilterMode = GpuTextureFilterModeName | (string & {});

export type GpuSamplerConfiguration = {
  // A comparison sampler (for depth textures, sampled with
  // textureSampleCompare): how the reference is compared with the depths.
  compare?: CompareFunction;
  label?: string;
  wrapModeS?: GpuTextureWrapMode;
  wrapModeT?: GpuTextureWrapMode;
  wrapModeR?: GpuTextureWrapMode;
  minFilter?: GpuTextureFilterMode;
  magFilter?: GpuTextureFilterMode;
  mipmapFilter?: GpuTextureFilterMode;
  // Anisotropic filtering: up to this many samples along the direction in
  // which the texture is stretched on screen (surfaces seen at a grazing
  // angle). Needs the three filters 'linear'. Clamped to the limit of the
  // device (capability maxAnisotropy). Defaults to the defaultMaxAnisotropy
  // of the factory for the samplers that can use it, else 1.
  maxAnisotropy?: number;
};

export interface GpuSampler extends Omit<
  Readonly<GpuSamplerConfiguration>,
  'label'
> {
  readonly label?: string;
  destroy(): void;
}

export interface GpuSamplerFactory {
  /**
   * The anisotropy of the samplers created afterwards without maxAnisotropy,
   * whose filters are all linear (comparison samplers excepted): a quality
   * setting of the application. 1 by default.
   */
  defaultMaxAnisotropy: number;
  createSampler(descriptor?: GpuSamplerConfiguration): GpuSampler;
}

/**
 * The anisotropy a sampler gets, the same on every backend: the one asked,
 * else the default when the filters allow it, clamped to the limit of the
 * device. Throws for an anisotropy asked with a 'nearest' filter, which
 * WebGPU refuses.
 */
export function samplerAnisotropy(
  configuration: GpuSamplerConfiguration,
  defaultMaxAnisotropy: number,
  limit: number,
): number {
  const linear =
    (configuration.minFilter ?? 'linear') === 'linear' &&
    (configuration.magFilter ?? 'linear') === 'linear' &&
    (configuration.mipmapFilter ?? 'linear') === 'linear';
  const asked = configuration.maxAnisotropy;
  if (asked !== undefined && !(asked >= 1)) {
    throw new Error(
      `Sampler "${
        configuration.label ?? '(unlabeled)'
      }": invalid maxAnisotropy ${asked}`,
    );
  }
  if (asked !== undefined && asked > 1 && !linear) {
    throw new Error(
      `Sampler "${
        configuration.label ?? '(unlabeled)'
      }": anisotropic filtering needs linear min, mag and mipmap filters`,
    );
  }
  // Comparison samplers read depths (shadow maps): not stretched textures.
  const anisotropy =
    asked ?? (linear && !configuration.compare ? defaultMaxAnisotropy : 1);
  return Math.max(1, Math.min(Math.floor(anisotropy), limit));
}
