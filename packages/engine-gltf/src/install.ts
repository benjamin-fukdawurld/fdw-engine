import type { ResourceStore } from '@fdw/engine-resources';
import { bufferLoader } from './buffers';
import { gltfExtensions } from './extensions';
import { gltfLoader } from './loader';
import { GltfConfigService, type GltfOptions } from './options';

/**
 * Registers the glTF loader in a store (with `installAssets`, which realizes
 * its models), its external buffers' loader, and its configuration: the
 * extensions, and the decoders the application chose (meshopt, Draco). It
 * mounts nothing: the `data:` URIs of the files are decoded by the loader.
 */
export function installGltf(
  store: ResourceStore,
  options: GltfOptions = {}
): ResourceStore {
  const extensions = new Map(gltfExtensions.map((e) => [e.name, e]));
  for (const extension of options.extensions ?? [])
    extensions.set(extension.name, extension);
  return store
    .registerLoader(gltfLoader)
    .registerLoader(bufferLoader)
    .provideService(GltfConfigService, { extensions, options });
}
