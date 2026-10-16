import { ResourceError, type ResourceBytes } from '@fdw/engine-resources';
import type {
  DecodedImage,
  ImageDecodeOptions,
  ImageDecoder,
} from './ImageDecoder';

export interface BitmapImageDecoderOptions {
  /** For tests, or a polyfill. Defaults to the global one. */
  readonly createImageBitmap?: typeof globalThis.createImageBitmap;
}

/**
 * Decodes with `createImageBitmap`. Colors are left alone: the browser would
 * otherwise convert them to the display profile and premultiply the alpha,
 * which corrupts data textures (a normal map is not a picture).
 */
export function createImageBitmapDecoder(
  options: BitmapImageDecoderOptions = {}
): ImageDecoder {
  return {
    async decode(
      bytes: ResourceBytes,
      { signal, mimeType }: ImageDecodeOptions = {}
    ): Promise<DecodedImage> {
      const aborted = () => new ResourceError('aborted', 'image decode');
      if (signal?.aborted) throw aborted();

      const create = options.createImageBitmap ?? globalThis.createImageBitmap;
      if (typeof create !== 'function') {
        throw new ResourceError(
          'unsupported',
          'image decode',
          'createImageBitmap is unavailable'
        );
      }
      let bitmap: ImageBitmap;
      try {
        bitmap = await create(
          new Blob([bytes], mimeType ? { type: mimeType } : undefined),
          {
            colorSpaceConversion: 'none',
            premultiplyAlpha: 'none',
          }
        );
      } catch (e) {
        throw new ResourceError(
          'decode',
          'image decode',
          'Cannot decode the image',
          { cause: e }
        );
      }
      if (signal?.aborted) {
        bitmap.close();
        throw aborted();
      }
      return { width: bitmap.width, height: bitmap.height, bitmap };
    },
  };
}
