// Writes the level of the TPS demo (packages/demo-scenes/src/tps/level.ts):
// the forest built by buildForest with its default options, from the models
// of apps/docs/public/models/forest, saved as forest.scene.json and its
// binary beside them. The level keeps the graph of the material of the
// ground: run it again when that graph, or a graph it calls (patchVertex of
// engine-tessellation), changes.
// Usage, from the root of the repository:
//   node --import @swc-node/register/esm-register \
//     --conditions=@fdw-engine/source tools/assets/make-tps-level.ts
//   [--folder apps/docs/public/models]
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { installAssets } from '@fdw/engine-assets';
import { fakeBackend } from '@fdw/engine-core/testing';
import { installGltf } from '@fdw/engine-gltf';
import { ScenePhysics } from '@fdw/engine-physics';
import { createRapierPhysics } from '@fdw/engine-physics-rapier';
import { ResourceStore } from '@fdw/engine-resources';
import { FileSource } from '@fdw/engine-resources-native';
import { Scene } from '@fdw/engine-scene';
import {
  buildForest,
  defineRock,
  loadTpsAssets,
  saveTpsLevel,
  TpsLevelPath,
} from '@fdw/demo-scenes';

const { values } = parseArgs({
  options: {
    folder: { type: 'string', default: 'apps/docs/public/models' },
  },
});
const folder = resolve(values.folder as string);

// Nothing is drawn: a backend without GPU. The level keeps the URIs of the
// images, not their pixels: each is decoded as a texel.
const { backend } = fakeBackend();
const store = new ResourceStore({ warn: () => undefined });
store.mount('file', new FileSource(folder), { default: true });
installAssets(store, {
  backend,
  codecs: [
    {
      name: 'texel',
      sniff: () => true,
      decode: async () => ({
        type: '2d',
        width: 1,
        height: 1,
        format: 'rgba8unorm',
        levels: [new Uint8Array(4)],
      }),
    },
  ],
});
installGltf(store);

const assets = await loadTpsAssets(store).ready;
// The rock, baked by the game: saved by its URI (RockUri).
const rock = backend.textures.createTexture({
  type: '2d',
  format: 'rgba8unorm',
  dimensions: { width: 4, height: 4 },
});
defineRock(store, backend, rock);

const rapier = await createRapierPhysics();
const scene = new Scene();
const physics = new ScenePhysics(scene, rapier.createWorld());
const forest = buildForest(backend, scene, physics, assets, rock);
const files = await saveTpsLevel(
  backend,
  scene,
  store,
  forest,
  TpsLevelPath,
  physics,
);
for (const file of files) {
  const path = join(folder, file.path);
  await writeFile(path, file.bytes);
  console.log(`${path}: ${file.bytes.byteLength} bytes`);
}
console.log(`${forest.treeCount} trees, play radius ${forest.playRadius}`);
