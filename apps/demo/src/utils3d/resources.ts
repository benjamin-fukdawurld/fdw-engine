import type { RenderBackend } from '@fdw/engine-backend';
import {
  bitmapCodec,
  installAssets,
  RenderBackendService,
} from '@fdw/engine-assets';
import { installGltf } from '@fdw/engine-gltf';
import { installObj } from '@fdw/engine-obj';
import { HttpSource, ResourceStore } from '@fdw/engine-resources';
import { createImageBitmapDecoder } from '@fdw/engine-resources-web';

let store: ResourceStore | undefined;

/**
 * The resources of the demo: one store for all the routes, reading the
 * files of public/. A route that gets another backend (the WebGPU / WebGL2
 * switch) makes the store realize its textures again on it.
 */
export function demoResources(backend: RenderBackend): ResourceStore {
  if (!store) {
    store = new ResourceStore();
    store.mount('http', new HttpSource({ base: '/' }), { default: true });
    installAssets(store, { codecs: [bitmapCodec(createImageBitmapDecoder())] });
    installObj(store);
    installGltf(store);
  }
  store.provideService(RenderBackendService, backend);
  return store;
}
