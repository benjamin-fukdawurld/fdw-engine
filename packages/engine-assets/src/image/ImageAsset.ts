import type { GpuTextureFormat } from '@fdw/engine-backend';
import { defineResourceType } from '@fdw/engine-resources';

/** The pixels of a level, or of all the layers of a level. */
export type ImageLevel = ArrayBufferView<ArrayBuffer>;

/** Data in a universal format, transcoded to a format of the backend (Basis Universal). */
export interface TranscodedImage {
  readonly format: GpuTextureFormat;
  readonly levels: readonly ImageLevel[];
}

/**
 * An image on the CPU side, independent of the backend: what the codecs
 * make of a file, and what a `Texture` uploads. The color space is not here:
 * it is a choice of the texture (§6.9 of the design), so one image can be
 * read as colors and as data.
 */
export interface ImageAsset {
  readonly type: '2d' | 'cube' | '2d-array' | '3d';
  readonly width: number;
  readonly height: number;
  /** Layers of a `2d-array`, depth of a `3d`, 6 for a cube; 1 by default. */
  readonly layers?: number;
  /**
   * A format of the backend, linear (`rgba8unorm`, `rgba16float`,
   * `bc7-rgba-unorm`…): the texture picks its `-srgb` variant for colors.
   * `'universal'` for the data of `transcode`.
   */
  readonly format: GpuTextureFormat | 'universal';
  /**
   * The levels, the largest first, each holding its layers one after the
   * other, rows from the top, tightly packed. Empty when `bitmap` holds the
   * single level.
   */
  readonly levels: readonly ImageLevel[];
  /** The single level, decoded by the browser: uploaded as is. */
  readonly bitmap?: ImageBitmap;
  /** For `'universal'` data: a format among those the backend samples, `rgba8unorm` as the last resort. */
  transcode?(
    formats: readonly GpuTextureFormat[],
    signal?: AbortSignal
  ): Promise<TranscodedImage>;
}

export const ImageAssetType = defineResourceType<ImageAsset>('image');

/** The bytes an image holds on the CPU. */
export function imageAssetSize(image: ImageAsset): number {
  if (image.bitmap) return image.width * image.height * 4;
  return image.levels.reduce((sum, level) => sum + level.byteLength, 0);
}

/** Frees what the image holds outside of the JavaScript heap (a bitmap). */
export function closeImageAsset(image: ImageAsset): void {
  image.bitmap?.close();
}
