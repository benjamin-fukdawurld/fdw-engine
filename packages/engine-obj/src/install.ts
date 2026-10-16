import type { ResourceStore } from '@fdw/engine-resources';
import { mtlLoader } from './mtl';
import { objLoader, type ObjOptions } from './obj';

/** Registers the loaders of OBJ and MTL files: `store.load(ModelType, 'tree.obj')`. */
export function installObj(
  store: ResourceStore,
  options: ObjOptions = {},
): ResourceStore {
  return store.registerLoader(objLoader(options)).registerLoader(mtlLoader);
}
