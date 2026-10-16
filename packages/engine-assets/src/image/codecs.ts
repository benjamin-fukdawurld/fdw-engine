import {
  extname,
  ResourceError,
  sniffImageFormat,
  type ImageFormat,
  type ResourceBytes,
} from '@fdw/engine-resources';
import type { ImageAsset } from './ImageAsset';
import { toHalfFloats } from './half';

export interface ImageCodecOptions {
  readonly signal?: AbortSignal;
  /** The URI of the image, for the messages. */
  readonly uri?: string;
}

/** Turns the bytes of an image file into an `ImageAsset`. */
export interface ImageCodec {
  readonly name: string;
  /** Lower-case, without the dot: `['png', 'jpg']`. */
  readonly extensions?: readonly string[];
  /** Recognizes the format from the first bytes of the file. */
  sniff?(head: Uint8Array): boolean;
  decode(
    bytes: ResourceBytes,
    options?: ImageCodecOptions
  ): Promise<ImageAsset>;
}

/**
 * The codecs of a store (its `ImageCodecsService`), chosen by the first bytes
 * of the file, then by its extension. The last registered wins.
 */
export class ImageCodecRegistry {
  private readonly codecs: ImageCodec[] = [];

  constructor(codecs: Iterable<ImageCodec> = []) {
    for (const codec of codecs) this.register(codec);
  }

  register(codec: ImageCodec): this {
    if (!this.codecs.includes(codec)) this.codecs.push(codec);
    return this;
  }

  get list(): readonly ImageCodec[] {
    return this.codecs;
  }

  find(bytes: Uint8Array, uri = ''): ImageCodec | undefined {
    const head = bytes.subarray(0, 64);
    const ext = extname(uri.split('#', 1)[0]);
    const reversed = [...this.codecs].reverse();
    return (
      reversed.find((c) => c.sniff?.(head)) ??
      reversed.find((c) => ext !== '' && c.extensions?.includes(ext))
    );
  }

  /** Decodes with the codec of the bytes; `unsupported` when none knows them. */
  decode(
    bytes: ResourceBytes,
    options: ImageCodecOptions = {}
  ): Promise<ImageAsset> {
    const uri = options.uri ?? 'image';
    const codec = this.find(bytes, uri);
    if (!codec) {
      const known = this.codecs.map((c) => c.name).join(', ') || 'none';
      return Promise.reject(
        new ResourceError(
          'unsupported',
          uri,
          `No image codec recognizes ${uri} (codecs: ${known})`
        )
      );
    }
    return codec.decode(bytes, options);
  }
}

const sniffing =
  (formats: readonly ImageFormat[]) =>
  (head: Uint8Array): boolean => {
    const format = sniffImageFormat(head);
    return format !== undefined && formats.includes(format);
  };

/** What `bitmapCodec` needs: the decoders of `@fdw/engine-resources-web`. */
export interface BitmapDecoder {
  decode(
    bytes: ResourceBytes,
    options?: { signal?: AbortSignal; mimeType?: string }
  ): Promise<{
    readonly width: number;
    readonly height: number;
    readonly bitmap: ImageBitmap;
  }>;
}

/**
 * A codec of the browser's formats from a decoder giving an `ImageBitmap`
 * (`createImageBitmapDecoder`, `createWorkerImageDecoder`): PNG, JPEG, GIF,
 * WebP, AVIF, BMP.
 */
export function bitmapCodec(
  decoder: BitmapDecoder,
  name = 'browser'
): ImageCodec {
  return {
    name,
    extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp'],
    sniff: sniffing(['png', 'jpeg', 'gif', 'webp', 'avif', 'bmp']),
    async decode(bytes, { signal } = {}) {
      const { width, height, bitmap } = await decoder.decode(bytes, { signal });
      return {
        type: '2d',
        width,
        height,
        format: 'rgba8unorm',
        levels: [],
        bitmap,
      };
    },
  };
}

/** What `pixelCodec` needs: the decoder of `@fdw/engine-resources-native`. */
export interface PixelDecoder {
  decode(
    bytes: ResourceBytes,
    options?: { signal?: AbortSignal }
  ): Promise<{
    readonly width: number;
    readonly height: number;
    readonly pixels: Uint8Array<ArrayBuffer> | Float32Array<ArrayBuffer>;
    readonly hdr?: boolean;
  }>;
}

/**
 * A codec from a decoder giving RGBA pixels (`createStbImageDecoder`): PNG,
 * JPEG, TGA, BMP, GIF, and HDR images as half floats (`rgba16float`, which
 * every backend filters, unlike `rgba32float`).
 */
export function pixelCodec(decoder: PixelDecoder, name = 'pixels'): ImageCodec {
  return {
    name,
    extensions: ['png', 'jpg', 'jpeg', 'tga', 'bmp', 'gif', 'hdr'],
    sniff: sniffing(['png', 'jpeg', 'gif', 'bmp', 'hdr']),
    async decode(bytes, { signal } = {}) {
      const { width, height, pixels } = await decoder.decode(bytes, { signal });
      if (pixels instanceof Float32Array) {
        return {
          type: '2d',
          width,
          height,
          format: 'rgba16float',
          levels: [toHalfFloats(pixels)],
        };
      }
      return {
        type: '2d',
        width,
        height,
        format: 'rgba8unorm',
        levels: [pixels],
      };
    },
  };
}
