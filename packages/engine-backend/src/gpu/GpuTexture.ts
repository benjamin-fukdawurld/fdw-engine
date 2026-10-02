export const GpuTextureTypeNames = ['2d', '2d-array', '3d', 'cube'] as const;
export type GpuTextureTypeName = (typeof GpuTextureTypeNames)[number];
export type GpuTextureType = GpuTextureTypeName | (string & {});

export const GpuTextureFormatNames = [
  'r8unorm',
  'rg8unorm',
  'rgba8unorm',
  'rgba8unorm-srgb',

  'r16float',
  'rg16float',
  'rgba16float',

  'r32float',
  'rg32float',
  'rgba32float',

  'r8uint',
  'rg8uint',
  'rgba8uint',

  'r16uint',
  'rg16uint',
  'rgba16uint',

  'r32uint',
  'rg32uint',
  'rgba32uint',

  'r8sint',
  'rg8sint',
  'rgba8sint',

  'r16sint',
  'rg16sint',
  'rgba16sint',

  'r32sint',
  'rg32sint',
  'rgba32sint',

  'rgb10a2unorm',
] as const;
export type GpuTextureFormatName = (typeof GpuTextureFormatNames)[number];
export type GpuTextureFormat = GpuTextureFormatName | (string & {});

export type GpuTextureDimensions = {
  width: number;
  height?: number;
  layers?: number;
};

export interface GpuTextureConfiguration {
  label?: string;
  type: GpuTextureType;
  format: GpuTextureFormat;
  dimensions: GpuTextureDimensions;
}

export interface GpuTexture extends Readonly<GpuTextureConfiguration> {
  destroy(): void;
}

export interface GpuTextureFactory<TextureSource = never> {
  createTexture(
    descriptor: GpuTextureConfiguration & {
      source?: TextureSource | ArrayBufferView<ArrayBuffer>;
      readwrite?: boolean;
    }
  ): GpuTexture;
}
