import type { GltfExtension } from '../extension';

/**
 * `KHR_texture_basisu`: the texture reads its KTX2 image, which the codec of
 * `installKtx2` decodes (and the texture transcodes for the backend).
 */
export const KHR_texture_basisu: GltfExtension = {
  name: 'KHR_texture_basisu',
  textureSource: (ext) => (ext as { source?: number }).source,
};
