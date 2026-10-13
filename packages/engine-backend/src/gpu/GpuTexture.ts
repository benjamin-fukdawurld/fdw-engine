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
  // Levels of detail, each half the size of the previous one: 1 (the
  // default) for none, fullMipLevelCount for the whole chain down to 1×1.
  // The first level is the one written, rendered to and read back; the
  // others are computed from it (see generateMipmaps).
  mipLevelCount?: number;
}

// The usage of the textures created without one.
export const defaultTextureUsage: readonly GpuTextureUsage[] = [
  'sampled',
  'copy-dst',
];

export interface GpuTexture extends Readonly<GpuTextureConfiguration> {
  destroy(): void;
}

/** The levels of a whole mipmap chain, down to 1×1. */
export const fullMipLevelCount = ({
  width,
  height = 1,
}: GpuTextureDimensions): number =>
  Math.floor(Math.log2(Math.max(width, height, 1))) + 1;

/**
 * Checks the levels of a texture: throws for a count the texture cannot
 * have. Returns the count (1 by default).
 */
export function checkMipLevelCount(
  configuration: GpuTextureConfiguration
): number {
  const {
    mipLevelCount = 1,
    sampleCount = 1,
    dimensions,
    label,
  } = configuration;
  const what = `Texture "${label ?? '(unlabeled)'}"`;
  const full = fullMipLevelCount(dimensions);
  if (!Number.isInteger(mipLevelCount) || mipLevelCount < 1) {
    throw new Error(`${what}: invalid mipLevelCount ${mipLevelCount}`);
  }
  if (mipLevelCount > full) {
    throw new Error(
      `${what}: ${mipLevelCount} levels, more than the ${full} of its size`
    );
  }
  if (mipLevelCount > 1 && sampleCount > 1) {
    throw new Error(`${what}: a multisampled texture has a single level`);
  }
  if (mipLevelCount > 1 && configuration.type === '3d') {
    throw new Error(`${what}: 3d textures have a single level`);
  }
  // The levels are only ever computed from the first one.
  if (mipLevelCount > 1 && !canGenerateMipmaps(configuration.format)) {
    throw new Error(
      `${what}: the levels of ${configuration.format} cannot be computed`
    );
  }
  return mipLevelCount;
}

/**
 * Whether the levels of a format can be computed by averaging texels:
 * color formats, not integer or depth ones.
 */
export const canGenerateMipmaps = (format: GpuTextureFormat): boolean =>
  !/int$|^depth/.test(format);

/** A rectangle of pixels of a texture, from its top left corner. */
export interface GpuTextureRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** How the pixels of a color format are stored. */
export interface GpuTexelLayout {
  readonly channels: number;
  readonly bytesPerChannel: number;
  readonly kind: 'unorm' | 'float' | 'uint' | 'sint';
}

/**
 * The layout of the pixels of a color format: undefined for the depth
 * formats and the packed ones (rgb10a2unorm).
 */
export function texelLayout(
  format: GpuTextureFormat
): GpuTexelLayout | undefined {
  const match = /^(rg?b?a?)(8|16|32)(unorm|float|uint|sint)(-srgb)?$/.exec(
    format.replace(/^bgra/, 'rgba')
  );
  if (!match) {
    return undefined;
  }
  return {
    channels: match[1].length,
    bytesPerChannel: Number(match[2]) / 8,
    kind: match[3] as GpuTexelLayout['kind'],
  };
}

/** The bytes of a pixel of a format: undefined for the depth formats. */
export function texelBytes(format: GpuTextureFormat): number | undefined {
  if (format === 'rgb10a2unorm') {
    return 4;
  }
  const layout = texelLayout(format);
  return layout && layout.channels * layout.bytesPerChannel;
}

/**
 * Checks that the region of a texture can be read back (see readTexture):
 * a color texture with one sample, the copy-src usage, and the region
 * inside it. Returns the region (the whole texture by default) and the
 * bytes of a pixel.
 */
export function checkReadRegion(
  texture: GpuTexture,
  region?: GpuTextureRegion
): { region: GpuTextureRegion; bytesPerPixel: number } {
  const what = `Texture "${texture.label ?? '(unlabeled)'}"`;
  const bytesPerPixel = texelBytes(texture.format);
  if (bytesPerPixel === undefined) {
    throw new Error(`${what}: ${texture.format} cannot be read back`);
  }
  if ((texture.sampleCount ?? 1) > 1) {
    throw new Error(`${what} is multisampled: resolve it to read it back`);
  }
  if (!(texture.usage ?? defaultTextureUsage).includes('copy-src')) {
    throw new Error(`${what} needs the copy-src usage to be read back`);
  }
  const { width, height = 1 } = texture.dimensions;
  const read = region ?? { x: 0, y: 0, width, height };
  const valid =
    [read.x, read.y, read.width, read.height].every(Number.isInteger) &&
    read.x >= 0 &&
    read.y >= 0 &&
    read.width > 0 &&
    read.height > 0 &&
    read.x + read.width <= width &&
    read.y + read.height <= height;
  if (!valid) {
    throw new Error(
      `${what}: the region ${JSON.stringify(
        read
      )} is not inside its ${width}×${height} pixels`
    );
  }
  return { region: read, bytesPerPixel };
}

export interface GpuTextureFactory<TextureSource = never> {
  /**
   * A texture, with the content of `source` when given (as writeTexture).
   * Throws for a mipLevelCount the texture cannot have (see
   * checkMipLevelCount).
   */
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
   * the new one. The texture needs the copy-dst usage (the default). The
   * data fills the first level; the other levels, if any, are computed
   * from it (see GpuCommandEncoder.generateMipmaps).
   */
  writeTexture(texture: GpuTexture, data: ArrayBufferView<ArrayBuffer>): void;

  /**
   * Reads a region of the first level of a texture back (the first layer;
   * the whole texture by default): rows from the top, tightly packed, in
   * the layout of its format (4 bytes per pixel for r32uint). In the order
   * of the queue: the content after the frames submitted before, without
   * waiting for the GPU; the promise resolves a frame or two later. The
   * texture needs the copy-src usage and a single sample, the region must
   * be inside it; depth textures cannot be read: throws otherwise (see
   * checkReadRegion).
   */
  readTexture(
    texture: GpuTexture,
    region?: GpuTextureRegion
  ): Promise<ArrayBuffer>;
}
