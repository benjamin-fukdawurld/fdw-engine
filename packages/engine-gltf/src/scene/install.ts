import type { ResourceStore } from '@fdw/engine-resources';
import { fileBytesLoader } from './export';
import { gltfSceneLoader } from './import';

/**
 * Registers the scenes of glTF files (`SceneDataType`, by
 * `gltfSceneLoader`) in a store with `installGltf`, which reads their
 * models, and the reading of the images `writeGltf` writes into a file.
 */
export function installGltfScenes(store: ResourceStore): ResourceStore {
  return store.registerLoader(gltfSceneLoader).registerLoader(fileBytesLoader);
}
