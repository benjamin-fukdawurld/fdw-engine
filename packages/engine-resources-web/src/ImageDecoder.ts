import type { ResourceBytes } from '@fdw/engine-resources';

/**
 * Decoded pixels, still on the CPU side of the engine: nothing here knows
 * WebGPU or WebGL2. `@fdw/engine-assets` turns it into an `ImageAsset`, then
 * into a `Texture`.
 */
export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  /** Ready for `createTexture({ source })`. Close it once uploaded. */
  readonly bitmap: ImageBitmap;
}

export interface ImageDecodeOptions {
  readonly signal?: AbortSignal;
  readonly mimeType?: string;
}

export interface ImageDecoder {
  decode(
    bytes: ResourceBytes,
    options?: ImageDecodeOptions
  ): Promise<DecodedImage>;
}

// Moved to the core, which the codecs of `@fdw/engine-assets` share.
export { sniffImageFormat, type ImageFormat } from '@fdw/engine-resources';
