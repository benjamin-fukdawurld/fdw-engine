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
  // Compressed formats, sampled only, where the device has them (see
  // BackendCapabilities.compressedFormats): blocks of 4×4 pixels.
  'bc1-rgba-unorm',
  'bc1-rgba-unorm-srgb',
  'bc3-rgba-unorm',
  'bc3-rgba-unorm-srgb',
  'bc4-r-unorm',
  'bc5-rg-unorm',
  'bc6h-rgb-ufloat',
  'bc7-rgba-unorm',
  'bc7-rgba-unorm-srgb',
  'etc2-rgb8unorm',
  'etc2-rgb8unorm-srgb',
  'etc2-rgba8unorm',
  'etc2-rgba8unorm-srgb',
  'eac-r11unorm',
  'eac-rg11unorm',
  'astc-4x4-unorm',
  'astc-4x4-unorm-srgb',
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
  // The first level is the one rendered to and read back; the others are
  // computed from it (see generateMipmaps), or written (the levels of
  // createTexture, the level of writeTexture).
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

/** The size of a level of a texture, in pixels: at least 1×1. */
export const levelDimensions = (
  { width, height = 1 }: GpuTextureDimensions,
  level: number
): { width: number; height: number } => ({
  width: Math.max(width >> level, 1),
  height: Math.max(height >> level, 1),
});

/**
 * Checks the levels of a texture: throws for a count the texture cannot
 * have. Returns the count (1 by default). `provided`: the levels are
 * written, not computed (the levels of createTexture), so that formats
 * whose levels cannot be computed can have several. Those of the
 * compressed formats are always written.
 */
export function checkMipLevelCount(
  configuration: GpuTextureConfiguration,
  { provided = false }: { provided?: boolean } = {}
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
  // Without data for them, the levels are computed from the first one.
  if (
    mipLevelCount > 1 &&
    !provided &&
    !isCompressedFormat(configuration.format) &&
    !canGenerateMipmaps(configuration.format)
  ) {
    throw new Error(
      `${what}: the levels of ${configuration.format} cannot be computed`
    );
  }
  return mipLevelCount;
}

/**
 * Whether the levels of a format can be computed by averaging texels:
 * color formats, not integer, depth or compressed ones (their levels come
 * with their data).
 */
export const canGenerateMipmaps = (format: GpuTextureFormat): boolean =>
  !/int$|^depth/.test(format) && !isCompressedFormat(format);

/** The pixels of a compressed format are stored by blocks. */
export interface GpuCompressedBlock {
  // Pixels.
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

const compressedBlocks: Record<string, GpuCompressedBlock> = (() => {
  const blocks: Record<string, GpuCompressedBlock> = {};
  const add = (bytes: number, ...formats: string[]) =>
    formats.forEach(
      (format) => (blocks[format] = { width: 4, height: 4, bytes })
    );
  add(8, 'bc1-rgba-unorm', 'bc1-rgba-unorm-srgb', 'bc4-r-unorm');
  add(8, 'etc2-rgb8unorm', 'etc2-rgb8unorm-srgb', 'eac-r11unorm');
  add(16, 'bc3-rgba-unorm', 'bc3-rgba-unorm-srgb', 'bc5-rg-unorm');
  add(16, 'bc6h-rgb-ufloat', 'bc7-rgba-unorm', 'bc7-rgba-unorm-srgb');
  add(16, 'etc2-rgba8unorm', 'etc2-rgba8unorm-srgb', 'eac-rg11unorm');
  add(16, 'astc-4x4-unorm', 'astc-4x4-unorm-srgb');
  return blocks;
})();

/** The blocks of a compressed format: undefined for the other formats. */
export function compressedBlock(
  format: GpuTextureFormat
): GpuCompressedBlock | undefined {
  return Object.hasOwn(compressedBlocks, format)
    ? compressedBlocks[format]
    : undefined;
}

export const isCompressedFormat = (format: GpuTextureFormat): boolean =>
  compressedBlock(format) !== undefined;

/**
 * The bytes of a layer of a level of a texture: rows from the top, tightly
 * packed; for a compressed format, rows of blocks, the last ones partly
 * outside the level (a 2×2 level is a block). Throws for the depth
 * formats.
 */
export function textureLevelSize(
  format: GpuTextureFormat,
  dimensions: GpuTextureDimensions,
  level: number
): number {
  const { width, height } = levelDimensions(dimensions, level);
  const block = compressedBlock(format);
  if (block) {
    return (
      Math.ceil(width / block.width) *
      Math.ceil(height / block.height) *
      block.bytes
    );
  }
  const bytes = texelBytes(format);
  if (bytes === undefined) {
    throw new Error(`The texels of ${format} cannot be written`);
  }
  return width * height * bytes;
}

/** The layers of a texture: 6 for a cube, the depth of a 3d texture. */
export const textureLayerCount = (
  texture: Pick<GpuTextureConfiguration, 'type' | 'dimensions'>
): number => (texture.type === 'cube' ? 6 : texture.dimensions.layers ?? 1);

/** Where writeTexture writes: a level, and a layer of it. */
export interface GpuTextureWriteOptions {
  // The level written alone, its levels not computed. Without it, the
  // first one, then the others are computed.
  readonly level?: number;
  // A layer of an array, a face of a cube (+x, -x, +y, -y, +z, -z); every
  // layer by default.
  readonly layer?: number;
}

/**
 * Checks a write of a level (see writeTexture): the level and the layer
 * inside the texture, the data of their size. Returns the level, the first
 * layer written and the count of layers.
 */
export function checkTextureWrite(
  texture: Readonly<GpuTextureConfiguration>,
  data: ArrayBufferView,
  { level = 0, layer }: GpuTextureWriteOptions
): { level: number; layer: number; layers: number } {
  const what = `Texture "${texture.label ?? '(unlabeled)'}"`;
  const levels = texture.mipLevelCount ?? 1;
  if (!Number.isInteger(level) || level < 0 || level >= levels) {
    throw new Error(`${what}: no level ${level} (it has ${levels})`);
  }
  const count = textureLayerCount(texture);
  if (layer !== undefined) {
    if (texture.type === '3d') {
      throw new Error(`${what}: 3d textures are written whole`);
    }
    if (!Number.isInteger(layer) || layer < 0 || layer >= count) {
      throw new Error(`${what}: no layer ${layer} (it has ${count})`);
    }
  }
  const layers = layer === undefined ? count : 1;
  const expected =
    textureLevelSize(texture.format, texture.dimensions, level) * layers;
  if (data.byteLength !== expected) {
    throw new Error(
      `${what}: level ${level} takes ${expected} bytes, not ${data.byteLength}`
    );
  }
  return { level, layer: layer ?? 0, layers };
}

/**
 * Checks the content of a new texture (see createTexture): a source or
 * levels, not both; a compressed format from bytes only; the levels of
 * their sizes. Returns the count of levels (that of the levels given by
 * default).
 */
export function checkTextureContent(
  descriptor: GpuTextureConfiguration & {
    source?: unknown;
    levels?: readonly ArrayBufferView[];
  }
): number {
  const { source, levels, format, label } = descriptor;
  const what = `Texture "${label ?? '(unlabeled)'}"`;
  if (source !== undefined && levels !== undefined) {
    throw new Error(`${what}: a source or levels, not both`);
  }
  if (source !== undefined && isCompressedFormat(format)) {
    if (!ArrayBuffer.isView(source)) {
      throw new Error(`${what}: ${format} is written from bytes only`);
    }
  }
  if (levels !== undefined && levels.length === 0) {
    throw new Error(`${what}: no levels given`);
  }
  const mipLevelCount = checkMipLevelCount(
    {
      ...descriptor,
      mipLevelCount: descriptor.mipLevelCount ?? levels?.length,
    },
    { provided: levels !== undefined }
  );
  if (levels && levels.length > mipLevelCount) {
    throw new Error(
      `${what}: ${levels.length} levels given, for ${mipLevelCount}`
    );
  }
  levels?.forEach((data, level) =>
    checkTextureWrite({ ...descriptor, mipLevelCount }, data, { level })
  );
  return mipLevelCount;
}

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
  // Undefined for the depth and compressed formats.
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
   * A texture, with the content of `source` when given (as writeTexture
   * without options), or of `levels`: the data of each level, the first
   * one first, each with all its layers (as writeTexture with a level).
   * The levels given are written as they are, not computed; mipLevelCount
   * defaults to their count. Compressed formats take bytes only, or no
   * content (written later). Throws for a mipLevelCount the texture cannot
   * have, or levels not of its size (see checkTextureContent).
   */
  createTexture(
    descriptor: GpuTextureConfiguration & {
      source?: TextureSource | ArrayBufferView<ArrayBuffer>;
      levels?: readonly ArrayBufferView<ArrayBuffer>[];
      readwrite?: boolean;
    }
  ): GpuTexture;

  /**
   * Replaces the content of a texture of this factory (every layer): rows
   * from the top, tightly packed, layer after layer (rows of blocks for
   * the compressed formats, see textureLevelSize). In the order of the
   * queue: the frames submitted before read the old content, those after,
   * the new one. The texture needs the copy-dst usage (the default).
   * Without options, the data fills the first level; the other levels, if
   * any, are computed from it where the format allows it (see
   * canGenerateMipmaps and GpuCommandEncoder.generateMipmaps). With a
   * level, the data fills that level only (of a layer only, with a
   * layer), nothing computed: throws for a level, a layer or a size the
   * texture does not have (see checkTextureWrite).
   */
  writeTexture(
    texture: GpuTexture,
    data: ArrayBufferView<ArrayBuffer>,
    options?: GpuTextureWriteOptions
  ): void;

  /**
   * Reads a region of the first level of a texture back (the first layer;
   * the whole texture by default): rows from the top, tightly packed, in
   * the layout of its format (4 bytes per pixel for r32uint). In the order
   * of the queue: the content after the frames submitted before, without
   * waiting for the GPU; the promise resolves a frame or two later. The
   * texture needs the copy-src usage and a single sample, the region must
   * be inside it; depth and compressed textures cannot be read: throws
   * otherwise (see checkReadRegion).
   */
  readTexture(
    texture: GpuTexture,
    region?: GpuTextureRegion
  ): Promise<ArrayBuffer>;
}
