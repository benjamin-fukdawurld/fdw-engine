import type {
  ImageAsset,
  ImageCodec,
  ImageCodecRegistry,
  ImageLevel,
  TranscodedImage,
} from '@fdw/engine-assets';
import {
  isCompressedFormat,
  textureLevelSize,
  type BackendCapabilities,
  type GpuTextureFormat,
} from '@fdw/engine-backend';
import { ResourceError, type ResourceBytes } from '@fdw/engine-resources';
import {
  isKtx2,
  Ktx2ColorModel,
  Ktx2Supercompression,
  parseKtx2,
  type Ktx2Container,
} from './container';
import { engineFormat } from './formats';

/** The formats a Basis Universal transcoder can write, by their `basis_transcoder` names. */
export type BasisTarget = 'bc7' | 'astc-4x4' | 'etc2' | 'etc1' | 'rgba8';

export interface BasisTranscodeOptions {
  readonly signal?: AbortSignal;
  /** The kind of the data: BasisLZ / ETC1S, or UASTC. */
  readonly kind: 'etc1s' | 'uastc';
  readonly hasAlpha: boolean;
}

/**
 * Transcodes the Basis Universal data of a KTX2 file, supplied by the
 * application (the engine does not ship the WASM). Over Binomial's
 * `basis_transcoder`: `new KTX2File(ktx2)`, `startTranscoding()`, then for
 * each level, each layer, each face, `transcodeImage(…)` with the
 * `transcoder_texture_format` of the target (`cTFBC7_RGBA`,
 * `cTFASTC_4x4_RGBA`, `cTFETC2_RGBA`, `cTFETC1_RGB`, `cTFRGBA32`).
 */
export interface BasisTranscoder {
  /**
   * One array per level, level 0 (the largest) first, each holding its
   * images one after the other: layer after layer, the 6 faces of a cube
   * (+x, -x, +y, -y, +z, -z) inside each layer. The data of the KTX2 file
   * can be supercompressed with zstd (UASTC): the transcoder inflates it.
   */
  transcode(
    ktx2: Uint8Array,
    target: BasisTarget,
    options: BasisTranscodeOptions
  ): BasisTranscodeResult | Promise<BasisTranscodeResult>;
}

export interface BasisTranscodeResult {
  readonly levels: readonly Uint8Array[];
}

/** Inflates zstd data (supercompression scheme 2), supplied by the application (the `zstddec` package…). */
export interface ZstdDecoder {
  decode(
    bytes: Uint8Array,
    uncompressedSize: number
  ): Uint8Array | Promise<Uint8Array>;
}

export interface Ktx2Options {
  /** For the Basis Universal data (BasisLZ / ETC1S, UASTC): `unsupported` without it. */
  readonly transcoder?: BasisTranscoder;
  /** For the zstd supercompressed files that are not Basis Universal: `unsupported` without it. */
  readonly zstd?: ZstdDecoder;
}

/** The formats a Basis Universal transcoding goes to, the preferred first. */
const basisTargets: readonly {
  target: BasisTarget;
  format: GpuTextureFormat;
  opaqueEtc1s?: boolean;
}[] = [
  { target: 'bc7', format: 'bc7-rgba-unorm' },
  { target: 'astc-4x4', format: 'astc-4x4-unorm' },
  { target: 'etc1', format: 'etc2-rgb8unorm', opaqueEtc1s: true },
  { target: 'etc2', format: 'etc2-rgba8unorm' },
];

/**
 * The target of a Basis Universal transcoding for a backend sampling
 * `formats`: BC7, then ASTC 4×4, then ETC2 (ETC1 for opaque ETC1S data,
 * read as ETC2 RGB), else uncompressed `rgba8unorm`.
 */
export function basisTarget(
  formats: readonly GpuTextureFormat[],
  kind: 'etc1s' | 'uastc',
  hasAlpha: boolean
): { target: BasisTarget; format: GpuTextureFormat } {
  const found = basisTargets.find(
    (t) =>
      formats.includes(t.format) &&
      (!t.opaqueEtc1s || (kind === 'etc1s' && !hasAlpha))
  );
  return found
    ? { target: found.target, format: found.format }
    : { target: 'rgba8', format: 'rgba8unorm' };
}

/**
 * Whether a backend can make a texture of an image: compressed formats
 * only where the device samples them (`compressedFormats`), universal data
 * when it has a transcoder.
 */
export function supportsImage(
  capabilities: BackendCapabilities | undefined,
  image: ImageAsset
): boolean {
  if (image.format === 'universal') return image.transcode !== undefined;
  return (
    !isCompressedFormat(image.format) ||
    (capabilities?.compressedFormats ?? []).includes(image.format)
  );
}

/**
 * Throws a `ResourceError('unsupported')` for an image the backend cannot
 * sample (see `supportsImage`): a KTX2 file in a GPU format is not
 * decompressed in software.
 */
export function ensureSupported(
  capabilities: BackendCapabilities | undefined,
  image: ImageAsset,
  uri = 'image'
): void {
  if (!supportsImage(capabilities, image)) {
    const what =
      image.format === 'universal'
        ? 'universal data without a transcoder'
        : image.format;
    throw new ResourceError(
      'unsupported',
      uri,
      `${uri}: the backend cannot sample ${what}`
    );
  }
}

/** The shape of the images of a KTX2 file: type, size, layers. */
interface Shape {
  readonly type: ImageAsset['type'];
  readonly width: number;
  readonly height: number;
  readonly layers: number;
}

function shapeOf(ktx: Ktx2Container, uri: string): Shape {
  const unsupported = (message: string) =>
    new ResourceError('unsupported', uri, `${uri}: ${message}`);
  const { pixelWidth: width, pixelDepth: depth, layerCount, faceCount } = ktx;
  const height = Math.max(ktx.pixelHeight, 1);
  if (faceCount !== 1 && faceCount !== 6)
    throw new ResourceError('decode', uri, `${uri}: ${faceCount} faces`);
  if (faceCount === 6) {
    if (layerCount > 0) throw unsupported('cube arrays are not supported');
    return { type: 'cube', width, height, layers: 6 };
  }
  if (depth > 0) {
    if (layerCount > 0)
      throw unsupported('arrays of 3d textures are not supported');
    return { type: '3d', width, height, layers: depth };
  }
  return layerCount > 0
    ? { type: '2d-array', width, height, layers: layerCount }
    : { type: '2d', width, height, layers: 1 };
}

/** The images of a level: its layers (faces), its depth for a 3d texture. */
const levelImages = (shape: Shape, level: number) =>
  shape.type === '3d' ? Math.max(shape.layers >> level, 1) : shape.layers;

/** Checks the sizes of the levels of a format: `decode` otherwise. */
function checkLevels(
  shape: Shape,
  format: GpuTextureFormat,
  levels: readonly ImageLevel[],
  uri: string
): void {
  levels.forEach((data, level) => {
    const expected =
      textureLevelSize(format, shape, level) * levelImages(shape, level);
    if (data.byteLength !== expected) {
      throw new ResourceError(
        'decode',
        uri,
        `${uri}: level ${level} of ${format} holds ${data.byteLength} bytes, not ${expected}`
      );
    }
  });
}

// The levels are ArrayBuffer views: what a decoder returns over another buffer is copied.
const owned = (bytes: Uint8Array): Uint8Array<ArrayBuffer> =>
  bytes.buffer instanceof ArrayBuffer
    ? (bytes as Uint8Array<ArrayBuffer>)
    : new Uint8Array(bytes);

async function inflate(
  data: Uint8Array<ArrayBuffer>
): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([data])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The data of the levels of a file in a GPU format, inflated. */
async function readLevels(
  bytes: ResourceBytes,
  ktx: Ktx2Container,
  options: Ktx2Options,
  uri: string,
  signal?: AbortSignal
): Promise<ImageLevel[]> {
  const scheme = ktx.supercompressionScheme;
  const { zstd } = options;
  if (scheme === Ktx2Supercompression.zstd && !zstd) {
    throw new ResourceError(
      'unsupported',
      uri,
      `${uri}: zstd supercompression needs a decoder (installKtx2(registry, { zstd }))`
    );
  }
  if (
    scheme !== Ktx2Supercompression.none &&
    scheme !== Ktx2Supercompression.zstd &&
    scheme !== Ktx2Supercompression.zlib
  ) {
    throw new ResourceError(
      'unsupported',
      uri,
      `${uri}: supercompression scheme ${scheme} for a GPU format`
    );
  }
  const levels: ImageLevel[] = [];
  for (const level of ktx.levels) {
    signal?.throwIfAborted();
    const data = bytes.subarray(
      level.byteOffset,
      level.byteOffset + level.byteLength
    );
    if (scheme === Ktx2Supercompression.none) {
      levels.push(data);
      continue;
    }
    try {
      levels.push(
        scheme === Ktx2Supercompression.zlib
          ? await inflate(data)
          : owned(await zstd!.decode(data, level.uncompressedByteLength))
      );
    } catch (cause) {
      throw new ResourceError(
        'decode',
        uri,
        `${uri}: cannot inflate level ${levels.length}`,
        { cause }
      );
    }
  }
  signal?.throwIfAborted();
  return levels;
}

/** The asset of Basis Universal data: the file, transcoded by the texture to a format of its backend. */
function universalImage(
  bytes: ResourceBytes,
  ktx: Ktx2Container,
  shape: Shape,
  options: Ktx2Options,
  uri: string
): ImageAsset {
  const { colorModel, samples } = ktx.dataFormat;
  const kind =
    colorModel === Ktx2ColorModel.etc1s
      ? 'etc1s'
      : colorModel === Ktx2ColorModel.uastc
      ? 'uastc'
      : undefined;
  if (!kind)
    throw new ResourceError(
      'unsupported',
      uri,
      `${uri}: undefined format with the color model ${colorModel}`
    );
  const scheme = ktx.supercompressionScheme;
  const expected =
    kind === 'etc1s'
      ? [Ktx2Supercompression.basisLZ]
      : [Ktx2Supercompression.none, Ktx2Supercompression.zstd];
  if (!expected.includes(scheme as never)) {
    throw new ResourceError(
      'unsupported',
      uri,
      `${uri}: ${kind} data with the supercompression scheme ${scheme}`
    );
  }
  // ETC1S: an alpha slice as the second sample; UASTC: the RGBA (3) and RRRG (5) channels.
  const hasAlpha =
    kind === 'etc1s'
      ? samples.length > 1
      : samples[0]?.channelId === 3 || samples[0]?.channelId === 5;
  const { transcoder } = options;
  return {
    type: shape.type,
    width: shape.width,
    height: shape.height,
    ...(shape.layers !== 1 && { layers: shape.layers }),
    format: 'universal',
    // The file itself: what the transcoder reads, and the bytes the image holds.
    levels: [bytes],
    async transcode(formats, signal): Promise<TranscodedImage> {
      if (!transcoder) {
        throw new ResourceError(
          'unsupported',
          uri,
          `${uri}: Basis Universal data needs a transcoder (installKtx2(registry, { transcoder }))`
        );
      }
      signal?.throwIfAborted();
      const { target, format } = basisTarget(formats, kind, hasAlpha);
      let result: BasisTranscodeResult;
      try {
        result = await transcoder.transcode(bytes, target, {
          signal,
          kind,
          hasAlpha,
        });
      } catch (cause) {
        if (signal?.aborted) throw cause;
        throw new ResourceError(
          'decode',
          uri,
          `${uri}: cannot transcode to ${target}`,
          { cause }
        );
      }
      signal?.throwIfAborted();
      if (result.levels.length !== ktx.levels.length) {
        throw new ResourceError(
          'decode',
          uri,
          `${uri}: the transcoder gave ${result.levels.length} levels, not ${ktx.levels.length}`
        );
      }
      const levels = result.levels.map(owned);
      checkLevels(shape, format, levels, uri);
      return { format, levels };
    },
  };
}

/**
 * The codec of the KTX2 files: 2d, cube, 2d-array and 3d images with their
 * levels, uncompressed or in a GPU format (BC, ETC2, EAC, ASTC 4×4),
 * supercompressed with zstd or zlib; Basis Universal data (BasisLZ /
 * ETC1S, UASTC) as `'universal'`, transcoded by the texture for its
 * backend. A file in a GPU format is given as is: the backend must sample
 * that format (see `supportsImage`), it is not decompressed in software.
 */
export function ktx2Codec(options: Ktx2Options = {}): ImageCodec {
  return {
    name: 'ktx2',
    extensions: ['ktx2'],
    sniff: isKtx2,
    async decode(bytes, { signal, uri = 'image.ktx2' } = {}) {
      const ktx = parseKtx2(bytes, uri);
      const shape = shapeOf(ktx, uri);
      if (ktx.vkFormat === 0)
        return universalImage(bytes, ktx, shape, options, uri);
      const format = engineFormat(ktx.vkFormat);
      if (!format)
        throw new ResourceError(
          'unsupported',
          uri,
          `${uri}: VkFormat ${ktx.vkFormat} is not supported`
        );
      const levels = await readLevels(bytes, ktx, options, uri, signal);
      checkLevels(shape, format, levels, uri);
      return {
        type: shape.type,
        width: shape.width,
        height: shape.height,
        ...(shape.layers !== 1 && { layers: shape.layers }),
        format,
        levels,
      };
    },
  };
}

/**
 * Adds the KTX2 codec to the codecs of a store: the registry that
 * `installAssets` returns (`installKtx2(installAssets(store, …), {
 * transcoder, zstd })`). Returns the codec.
 */
export function installKtx2(
  registry: ImageCodecRegistry,
  options: Ktx2Options = {}
): ImageCodec {
  const codec = ktx2Codec(options);
  registry.register(codec);
  return codec;
}
