import type { RenderBackend } from '@fdw/engine-backend';
import type { ResourceStore } from '@fdw/engine-resources';
import { ImageCodecRegistry, type ImageCodec } from './image/codecs';
import { imageAssetLoader } from './image/imageLoader';
import { textureLoader } from './image/Texture';
import { materialLoader } from './materials';
import { meshLoader } from './meshes';
import { modelLoader } from './models';
import {
  AssetsConfigService,
  defaultAssetsConfig,
  ImageCodecsService,
  RenderBackendService,
  type AssetsConfig,
} from './services';

export interface InstallAssetsOptions extends Partial<AssetsConfig> {
  /** The backend of the realizations; `provideService(RenderBackendService, …)` later otherwise. */
  readonly backend?: RenderBackend;
  /** The image codecs: `bitmapCodec(…)` on the web, `pixelCodec(…)` in Node. */
  readonly codecs?: Iterable<ImageCodec>;
}

/**
 * Registers the loaders of the graphical assets in a store (images,
 * textures, meshes, materials, models) and their services. Returns the
 * codec registry, to which formats can add theirs (`installKtx2`).
 */
export function installAssets(
  store: ResourceStore,
  options: InstallAssetsOptions = {},
): ImageCodecRegistry {
  const { backend, codecs = [], ...config } = options;
  const registry = new ImageCodecRegistry(codecs);
  store
    .registerLoader(imageAssetLoader)
    .registerLoader(textureLoader)
    .registerLoader(meshLoader)
    .registerLoader(materialLoader)
    .registerLoader(modelLoader)
    .provideService(ImageCodecsService, registry)
    .provideService(AssetsConfigService, { ...defaultAssetsConfig, ...config });
  if (backend) store.provideService(RenderBackendService, backend);
  return registry;
}
