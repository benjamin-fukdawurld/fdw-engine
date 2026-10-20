import {
  canGenerateMipmaps,
  fullMipLevelCount,
  GpuTextureFormatNames,
  isCompressedFormat,
  texelBytes,
  type GpuSampler,
  type GpuSamplerConfiguration,
  type GpuTexture,
  type GpuTextureFormat,
  type RenderBackend,
} from '@fdw/engine-backend';
import {
  defineResourceType,
  ResourceError,
  type LoadContext,
  type ResourceHandle,
  type ResourceLoader,
  type ResourceStore,
  type ResourceUri,
} from '@fdw/engine-resources';
import {
  AssetsConfigService,
  ImageCodecsService,
  RenderBackendService,
} from '../services';
import {
  closeImageAsset,
  ImageAssetType,
  type ImageAsset,
  type ImageLevel,
} from './ImageAsset';

export interface TextureOptions {
  /**
   * How the texels are read: `'srgb'` (the default) for colors, decoded to
   * linear values by the GPU; `'linear'` for data (normal maps, roughness).
   */
  readonly colorSpace?: 'srgb' | 'linear';
  /**
   * The levels of detail: `'file'` uses those of the file (KTX2), `'generate'`
   * computes them, `'none'` has a single level. By default, those of the
   * file if it has some, else computed when the format allows it.
   */
  readonly mips?: 'generate' | 'none' | 'file';
  /** The sampler of the texture: repeated, linear filters by default. */
  readonly sampler?: GpuSamplerConfiguration;
}

/** An image on the GPU, with the sampler it is read with. */
export interface Texture {
  readonly texture: GpuTexture;
  readonly sampler: GpuSampler;
  readonly width: number;
  readonly height: number;
  readonly colorSpace: 'srgb' | 'linear';
}

export const TextureType = defineResourceType<Texture>('texture');

export const defaultSampler: GpuSamplerConfiguration = {
  wrapModeS: 'repeat',
  wrapModeT: 'repeat',
  minFilter: 'linear',
  magFilter: 'linear',
  mipmapFilter: 'linear',
};

const formats = new Set<string>(GpuTextureFormatNames);

/** The `-srgb` variant of a format, when it has one. */
export const srgbFormat = (format: GpuTextureFormat): GpuTextureFormat =>
  formats.has(`${format}-srgb`) ? `${format}-srgb` : format;

// Samplers are small and shared: one per configuration and backend, kept
// as long as the backend.
const samplers = new WeakMap<RenderBackend, Map<string, GpuSampler>>();

/** The sampler of a configuration, shared by everything that asks for it. */
export function sharedSampler(
  backend: RenderBackend,
  configuration: GpuSamplerConfiguration = defaultSampler,
): GpuSampler {
  let cache = samplers.get(backend);
  if (!cache) samplers.set(backend, (cache = new Map()));
  const key = JSON.stringify(configuration);
  let sampler = cache.get(key);
  if (!sampler)
    cache.set(key, (sampler = backend.textures.createSampler(configuration)));
  return sampler;
}

// The Texture of each GpuTexture made here: a material holds the GpuTexture,
// a saved scene needs the URI of the Texture (ResourceStore.identify).
const textures = new WeakMap<GpuTexture, Texture>();

/** The Texture a GpuTexture was made for, by createTextureFromImage. */
export const textureOf = (texture: GpuTexture): Texture | undefined =>
  textures.get(texture);

/**
 * Defines a texture made by code (baked, rendered) in a store under a URI:
 * the materials using it are saved with that URI, and load it where it is
 * defined again. Released with the last handle, like `store.define`.
 */
export function defineTexture(
  store: ResourceStore,
  uri: ResourceUri,
  texture: Texture,
): ResourceHandle<Texture> {
  textures.set(texture.texture, texture);
  return store.define(TextureType, uri, texture);
}

/** Uploads an image: the GPU side of the texture loader, usable on its own. */
export async function createTextureFromImage(
  backend: RenderBackend,
  image: ImageAsset,
  options: TextureOptions = {},
  label?: string,
  signal?: AbortSignal,
): Promise<Texture> {
  const colorSpace = options.colorSpace ?? 'srgb';
  let format: GpuTextureFormat;
  let levels: readonly ImageLevel[] = image.levels;
  if (image.format === 'universal') {
    if (!image.transcode) {
      throw new ResourceError(
        'unsupported',
        label ?? 'texture',
        'Universal image data without a transcoder',
      );
    }
    const transcoded = await image.transcode(
      backend.capabilities?.compressedFormats ?? [],
      signal,
    );
    format = transcoded.format;
    levels = transcoded.levels;
  } else {
    format = image.format;
  }
  // A compressed format the device cannot sample: no software decoding.
  if (
    isCompressedFormat(format) &&
    !backend.capabilities?.compressedFormats?.includes(format)
  ) {
    throw new ResourceError(
      'unsupported',
      label ?? 'texture',
      `The backend cannot sample ${format} textures`,
    );
  }
  if (colorSpace === 'srgb') format = srgbFormat(format);

  const fileLevels = !image.bitmap && levels.length > 1;
  const mips =
    options.mips ??
    (fileLevels ? 'file' : canGenerateMipmaps(format) ? 'generate' : 'none');
  const dimensions = {
    width: image.width,
    height: image.height,
    layers: image.layers ?? 1,
  };
  const base = { label, type: image.type, format, dimensions };
  let texture: GpuTexture;
  if (mips === 'file' && !image.bitmap) {
    texture = backend.textures.createTexture({
      ...base,
      mipLevelCount: levels.length,
      levels,
    });
  } else {
    const generate =
      mips === 'generate' && canGenerateMipmaps(format) && image.type !== '3d';
    texture = backend.textures.createTexture({
      ...base,
      mipLevelCount: generate ? fullMipLevelCount(dimensions) : 1,
      source: image.bitmap ?? levels[0],
    });
  }
  const result: Texture = {
    texture,
    sampler: sharedSampler(backend, options.sampler ?? defaultSampler),
    width: image.width,
    height: image.height,
    colorSpace,
  };
  textures.set(texture, result);
  return result;
}

/** An estimate of the bytes of a texture on the GPU, for the budget of the cache. */
export function textureSize({ texture }: Texture): number {
  const { width, height = 1, layers = 1 } = texture.dimensions;
  const base = width * height * layers * (texelBytes(texture.format) ?? 1);
  return (texture.mipLevelCount ?? 1) > 1 ? Math.ceil((base * 4) / 3) : base;
}

/**
 * Textures from images: the bytes of the URI decoded by the codecs of the
 * store, then uploaded. With `keepCpuData: 'always'`, the image is a shared
 * dependency (`ImageAssetType`) kept on the CPU; otherwise it is decoded
 * here and freed once uploaded.
 */
export const textureLoader: ResourceLoader<
  Texture,
  TextureOptions | undefined
> = {
  type: TextureType,
  cacheKey: (options) =>
    options
      ? JSON.stringify([
          options.colorSpace ?? 'srgb',
          options.mips ?? '',
          options.sampler ?? '',
        ])
      : '',
  async load(ctx: LoadContext<TextureOptions | undefined>) {
    const backend = ctx.service(RenderBackendService);
    const config = ctx.service(AssetsConfigService);
    if (config.keepCpuData === 'always') {
      const image = await ctx.use(ImageAssetType, ctx.uri).ready;
      return createTextureFromImage(
        backend,
        image,
        ctx.options,
        ctx.uri,
        ctx.signal,
      );
    }
    const image = await ctx
      .service(ImageCodecsService)
      .decode(await ctx.bytes(), { signal: ctx.signal, uri: ctx.uri });
    try {
      ctx.signal.throwIfAborted();
      return await createTextureFromImage(
        backend,
        image,
        ctx.options,
        ctx.uri,
        ctx.signal,
      );
    } finally {
      closeImageAsset(image);
    }
  },
  dispose: (value) => value.texture.destroy(),
  sizeOf: textureSize,
};

// One per backend, shared, never destroyed.
const placeholders = new WeakMap<RenderBackend, Texture>();

/**
 * A magenta and black checker: what a material shows in place of a texture
 * that failed to load (`onMissing: 'placeholder'`).
 */
export function placeholderTexture(backend: RenderBackend): Texture {
  let texture = placeholders.get(backend);
  if (!texture) {
    const pixels = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i++) {
      const magenta = ((i % 4) + Math.floor(i / 4)) % 2 === 0;
      pixels.set(magenta ? [255, 0, 255, 255] : [0, 0, 0, 255], i * 4);
    }
    texture = {
      texture: backend.textures.createTexture({
        label: 'placeholder',
        type: '2d',
        format: 'rgba8unorm',
        dimensions: { width: 4, height: 4 },
        source: pixels,
      }),
      sampler: sharedSampler(backend, {
        ...defaultSampler,
        minFilter: 'nearest',
        magFilter: 'nearest',
        mipmapFilter: 'nearest',
      }),
      width: 4,
      height: 4,
      colorSpace: 'linear',
    };
    placeholders.set(backend, texture);
  }
  return texture;
}
