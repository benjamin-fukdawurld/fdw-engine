import type { RenderBackend } from '@fdw/engine-backend';
import { defineServiceKey } from '@fdw/engine-resources';
import type { ImageCodecRegistry } from './image/codecs';

/**
 * The render backend of the realizations (textures, materials). Providing
 * another one (the WebGPU / WebGL2 switch of the demo) realizes them again
 * from their data, without reading the files again when the data is kept.
 */
export const RenderBackendService =
  defineServiceKey<RenderBackend>('render-backend');

/** The image codecs: the decoders of the platform, KTX2… */
export const ImageCodecsService =
  defineServiceKey<ImageCodecRegistry>('image-codecs');

export interface AssetsConfig {
  /**
   * Whether the pixels of the images stay on the CPU once uploaded:
   * `'never'` (the default) frees them, and a change of backend reads the
   * files again; `'always'` keeps them (an editor), shared by the textures
   * of an image (sRGB and linear).
   */
  readonly keepCpuData: 'always' | 'never';
  /**
   * What a material does with a texture that fails to load: `'placeholder'`
   * (the default) shows a magenta checker and reports the error on the
   * texture's handle, `'fail'` fails the material.
   */
  readonly onMissing: 'placeholder' | 'fail';
  /** Receives the warnings of the loaders (a mesh without a material…). */
  readonly warn: (message: string) => void;
}

export const AssetsConfigService =
  defineServiceKey<AssetsConfig>('assets-config');

export const defaultAssetsConfig: AssetsConfig = {
  keepCpuData: 'never',
  onMissing: 'placeholder',
  warn: (message) => console.warn(`[assets] ${message}`),
};
