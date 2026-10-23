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
import { bitmapCodec, installAssets } from '@fdw/engine-assets';
import { installGltf } from '@fdw/engine-gltf';
import { createRapierPhysics } from '@fdw/engine-physics-rapier';
import { HttpSource, ResourceStore } from '@fdw/engine-resources';
import { createImageBitmapDecoder } from '@fdw/engine-resources-web';

// The scenes the viewport can show: those of the desktop editor, by the
// same names. Loaded when chosen: some load something first (Rapier, a
// WebAssembly module; models).
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
    // The models of the forest, served by the application (vite.config.mts).
    const store = new ResourceStore();
    const base = `${import.meta.env.BASE_URL}models/`;
    store.mount('http', new HttpSource({ base }), { default: true });
    installAssets(store, { codecs: [bitmapCodec(createImageBitmapDecoder())] });
    installGltf(store);
    return createTpsScene({
      physics: await createRapierPhysics(),
      resources: () => store,
      level: TpsLevelPath,
    });
  },
};
