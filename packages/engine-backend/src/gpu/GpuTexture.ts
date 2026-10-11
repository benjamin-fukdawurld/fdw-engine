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
  // Surface formats.
  'bgra8unorm',
  'bgra8unorm-srgb',
  // Depth formats, for depth attachments.
  'depth16unorm',
  'depth24plus',
  'depth24plus-stencil8',
  'depth32float',
] as const;
export type GpuTextureFormatName = (typeof GpuTextureFormatNames)[number];
export type GpuTextureFormat = GpuTextureFormatName | (string & {});

export type GpuTextureDimensions = {
  width: number;
  height?: number;
  layers?: number;
};

// How a texture can be used: sampled by shaders, written by compute stages,
// rendered to, copied from or to.
export type GpuTextureUsage =
  | 'sampled'
  | 'storage'
  | 'render-attachment'
  | 'copy-src'
  | 'copy-dst';

export interface GpuTextureConfiguration {
  label?: string;
  type: GpuTextureType;
  format: GpuTextureFormat;
  dimensions: GpuTextureDimensions;
  // Defaults to sampled and copy-dst (and render-attachment for images).
  usage?: readonly GpuTextureUsage[];
  // Samples per pixel (4) of a multisampled render attachment, resolved
  // into a texture at the end of the passes. Default 1.
  sampleCount?: number;
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

  /**
   * Replaces the content of a texture of this factory (every layer): rows
   * from the top, tightly packed, layer after layer. In the order of the
   * queue: the frames submitted before read the old content, those after,
   * the new one. The texture needs the copy-dst usage (the default).
   */
  writeTexture(texture: GpuTexture, data: ArrayBufferView<ArrayBuffer>): void;
}
