import type { ResourceLoader } from '@fdw/engine-resources';
import { ImageCodecsService } from '../services';
import {
  closeImageAsset,
  imageAssetSize,
  ImageAssetType,
  type ImageAsset,
} from './ImageAsset';

/** Images on the CPU: the bytes of the URI decoded by the codecs of the store. */
export const imageAssetLoader: ResourceLoader<ImageAsset> = {
  type: ImageAssetType,
  async load(ctx) {
    return ctx
      .service(ImageCodecsService)
      .decode(await ctx.bytes(), { signal: ctx.signal, uri: ctx.uri });
  },
  dispose: closeImageAsset,
  sizeOf: imageAssetSize,
};
