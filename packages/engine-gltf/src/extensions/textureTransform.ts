import type { GltfExtension } from '../extension';

interface TextureTransform {
  readonly offset?: readonly [number, number];
  readonly rotation?: number;
  readonly scale?: readonly [number, number];
  readonly texCoord?: number;
}

/** `KHR_texture_transform`: offset, rotation and scale of the uv, and another uv set. */
export const KHR_texture_transform: GltfExtension = {
  name: 'KHR_texture_transform',
  textureInfo(ext, ref) {
    const {
      offset = [0, 0],
      rotation = 0,
      scale = [1, 1],
      texCoord,
    } = ext as TextureTransform;
    return {
      ...ref,
      texCoord: texCoord ?? ref.texCoord,
      transform: { offset, rotation, scale },
    };
  },
};
