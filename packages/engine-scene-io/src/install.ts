import type { ResourceStore } from '@fdw/engine-resources';
import { fdwSceneLoader, sceneBufferLoader } from './format';

/**
 * Registers the loader of the scenes of the engine (`.scene.json`, as
 * `SceneDataType`) in a store; installAssets is needed for their meshes
 * and materials.
 */
export function installSceneIo(store: ResourceStore): ResourceStore {
  return store.registerLoader(fdwSceneLoader).registerLoader(sceneBufferLoader);
}
