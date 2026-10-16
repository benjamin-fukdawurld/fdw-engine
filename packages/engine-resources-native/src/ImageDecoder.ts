import {
  loadAddon,
  type DecodedNativeImage,
  type NativeAddon,
} from '@fdw/engine-native';
import {
  ResourceError,
  sniffImageFormat,
  type ImageFormat,
  type ResourceBytes,
} from '@fdw/engine-resources';

/**
 * Decoded pixels, still on the CPU side of the engine: nothing here knows
 * the GPU. `@fdw/engine-assets` turns it into an `ImageAsset` (`pixelCodec`).
 */
export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  /** RGBA, rows from the top, straight alpha: bytes, or floats for HDR. */
  readonly pixels: Uint8Array<ArrayBuffer> | Float32Array<ArrayBuffer>;
  readonly hdr: boolean;
}

export interface ImageDecodeOptions {
  readonly signal?: AbortSignal;
  readonly mimeType?: string;
}

export interface ImageDecoder {
  decode(
    bytes: ResourceBytes,
    options?: ImageDecodeOptions,
  ): Promise<DecodedImage>;
}

export interface StbImageDecoderOptions {
  /** For tests. Defaults to the addon of `@fdw/engine-native`. */
  readonly addon?: Pick<NativeAddon, 'decodeImage'>;
}

/** The formats `createStbImageDecoder` reads. */
export const stbImageFormats = [
  'png',
  'jpeg',
  'tga',
  'bmp',
  'gif',
  'hdr',
] as const;

/**
 * Decodes with `stb_image`, in the addon of `@fdw/engine-native`, on the
 * thread pool of libuv: the event loop is never blocked. PNG, JPEG, TGA,
 * BMP, GIF (first frame) and HDR (Radiance, as floats).
 */
export function createStbImageDecoder({
  addon,
}: StbImageDecoderOptions = {}): ImageDecoder {
  return {
    async decode(bytes, { signal } = {}) {
      if (signal?.aborted) throw new ResourceError('aborted', 'image decode');
      let image: DecodedNativeImage;
      try {
        image = await (addon ?? loadAddon()).decodeImage(bytes);
      } catch (e) {
        throw new ResourceError(
          'decode',
          'image decode',
          `Cannot decode the image: ${(e as Error).message}`,
          {
            cause: e,
          },
        );
      }
      // The pool cannot be interrupted: the result is dropped.
      if (signal?.aborted) throw new ResourceError('aborted', 'image decode');
      return {
        width: image.width,
        height: image.height,
        pixels: image.pixels,
        hdr: image.hdr,
      };
    },
  };
}

const stbSniffed = new Set<ImageFormat | undefined>([
  'png',
  'jpeg',
  'gif',
  'bmp',
  'hdr',
]);

/** Recognizes the formats of `createStbImageDecoder` from their first bytes (TGA has no signature). */
export function sniffStbImage(head: Uint8Array): boolean {
  return stbSniffed.has(sniffImageFormat(head));
}
