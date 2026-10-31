import {
  createCity,
  createCityScene,
  createCoast,
  createCoastScene,
  createDecor,
  createDecorScene,
  createFpsScene,
  createMazeStep1,
  createMazeStep2,
  createMazeStep3,
  createMazeStep4,
  createPbrScene,
  createPhysicsScene,
  createProceduralGallery,
  createShadowsScene,
  createTerrain,
  createTerrainScene,
  createTpsScene,
  SceneFactory,
  TpsLevelPath,
} from '@fdw/demo-scenes';
import { installAssets, pixelCodec } from '@fdw/engine-assets';
import { installGltf } from '@fdw/engine-gltf';
import { createRapierPhysics } from '@fdw/engine-physics-rapier';
import { ResourceStore } from '@fdw/engine-resources';
import {
  createStbImageDecoder,
  FileSource,
} from '@fdw/engine-resources-native';

// Given by the main process: those of the documentation, or of the
// executable.
const modelsDirectory = process.env['FDW_MODELS'] ?? '';

// The scenes the viewport can show: those of apps/demo-native, by the same
// names. Loaded when chosen: some load something first (Rapier, the same
// WebAssembly module as in the browser; models).
export const scenes: Record<string, () => Promise<SceneFactory>> = {
  shadows: async () => createShadowsScene,
  pbr: async () => createPbrScene,
  // The game: its last step, and the steps before.
  maze: async () => createMazeStep4,
  'maze-1': async () => createMazeStep1,
  'maze-2': async () => createMazeStep2,
  'maze-3': async () => createMazeStep3,
  fps: async () => createFpsScene,
  city: async () => createCityScene,
  'city-no-occlusion': async () => createCity({ occlusion: false }),
  decor: async () => createDecorScene,
  'decor-no-batching': async () => createDecor({ batching: false }),
  terrain: async () => createTerrainScene,
  'terrain-uniform': async () => createTerrain({ minLevel: 6 }),
  procedural: async () => createProceduralGallery,
  physics: async () => createPhysicsScene(await createRapierPhysics()),
  coast: async () => createCoastScene(await createRapierPhysics()),
  'coast-gerstner': async () =>
    createCoast(await createRapierPhysics(), { waves: 'gerstner' }),
  tps: async () => {
    // The models of the forest.
    const store = new ResourceStore();
    store.mount('file', new FileSource(modelsDirectory), { default: true });
    installAssets(store, { codecs: [pixelCodec(createStbImageDecoder())] });
    installGltf(store);
    return createTpsScene({
      physics: await createRapierPhysics(),
      resources: () => store,
      level: TpsLevelPath,
    });
  },
};
