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
  label?: string;
  wrapModeS?: GpuTextureWrapMode;
  wrapModeT?: GpuTextureWrapMode;
  wrapModeR?: GpuTextureWrapMode;
  minFilter?: GpuTextureFilterMode;
  magFilter?: GpuTextureFilterMode;
  mipmapFilter?: GpuTextureFilterMode;
  maxAnisotropy?: number;
};

export interface GpuSampler
  extends Omit<Readonly<GpuSamplerConfiguration>, 'label'> {
  readonly label?: string;
  destroy(): void;
}

export interface GpuSamplerFactory {
  createSampler(descriptor?: GpuSamplerConfiguration): GpuSampler;
}
