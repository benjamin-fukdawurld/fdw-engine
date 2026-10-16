import {
  defineResourceType,
  type ResourceBytes,
  type ResourceLoader,
} from '@fdw/engine-resources';

/**
 * The external buffers of a `.gltf` (`scene.bin`): resources of their own,
 * so two files sharing one read it once, and a load cancelled cancels it.
 */
export const BufferType = defineResourceType<ResourceBytes>('buffer');

export const bufferLoader: ResourceLoader<ResourceBytes> = {
  type: BufferType,
  load: (ctx) => ctx.bytes(),
  sizeOf: (bytes) => bytes.byteLength,
};
