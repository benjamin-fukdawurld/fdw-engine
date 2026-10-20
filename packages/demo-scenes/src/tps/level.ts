import { defineTexture, sharedSampler, type Texture } from '@fdw/engine-assets';
import type { GpuTexture, RenderBackend } from '@fdw/engine-backend';
import type { Material } from '@fdw/engine-core';
import { physicsCodec, type ScenePhysics } from '@fdw/engine-physics';
import type { ResourceHandle, ResourceStore } from '@fdw/engine-resources';
import {
  SceneLods,
  type Component,
  type Scene,
  type World,
} from '@fdw/engine-scene';
import {
  captureScene,
  installSceneIo,
  instantiateScene,
  lodCodec,
  sceneCodecs,
  SceneDataType,
  writeFdwScene,
  type ComponentCodec,
  type ExportedFile,
  type ResourceRef,
} from '@fdw/engine-scene-io';
import { buildTerrain, type Terrain } from '../terrain/terrain';
import type { Forest } from './forest';

// The forest of the TPS demo as a level: built once by buildForest, saved
// as a scene of the engine (forest.scene.json and its binary), loaded by
// the game. Two components of its own: the terrain, drawn as an item of
// patches (not a node), and what the game needs of the forest.

/** Where the level is, beside the models (tools/assets/make-tps-level.ts writes it). */
export const TpsLevelPath = 'forest/forest.scene.json';

/** The URI the baked rock of the slopes is defined under, in the store. */
export const RockUri = 'generated/rock.texture';

/** The options of the terrain, saved with it. */
export interface SavedTerrain {
  readonly size: number;
  readonly height: number;
  readonly resolution: number;
  readonly heights: Float32Array;
  readonly patches: number;
  readonly edgePixels: number;
}

type TerrainSchema = { terrain: 'ref'; ground: 'ref'; options: 'ref' };
type ForestSchema = { trees: 'ref'; playRadius: 'f32' };
const components = new WeakMap<
  World,
  { Terrain: Component<TerrainSchema>; Forest: Component<ForestSchema> }
>();

/**
 * The components of the level: `tps terrain` (the terrain, its material
 * of ground, its options), `tps forest` (the trunks: x, z, radius; the
 * radius of the play area).
 */
export function levelComponents(scene: Scene) {
  let found = components.get(scene.world);
  if (!found) {
    found = {
      Terrain: scene.world.defineComponent('tps terrain', {
        terrain: 'ref',
        ground: 'ref',
        options: 'ref',
      }),
      Forest: scene.world.defineComponent('tps forest', {
        trees: 'ref',
        playRadius: 'f32',
      }),
    };
    components.set(scene.world, found);
  }
  return found;
}

/**
 * The codecs of the level: those of the scene, the levels of detail, the
 * bodies, the terrain (made again by buildTerrain) and the forest.
 */
export function levelCodecs(
  backend: RenderBackend,
  scene: Scene,
  lods: SceneLods,
  physics?: ScenePhysics,
): ComponentCodec<any>[] {
  const { Terrain, Forest } = levelComponents(scene);
  const terrain: ComponentCodec<
    SavedTerrain & { readonly ground: ResourceRef }
  > = {
    name: Terrain.name,
    version: 1,
    write: (entity, ctx) => ({
      ...(Terrain.options[entity] as SavedTerrain),
      ground: ctx.material(Terrain.ground[entity] as Material)!,
    }),
    async read({ ground: ref, ...options }, entity, ctx) {
      const ground = await ctx.material(ref);
      const made = buildTerrain(backend, {
        ...options,
        material: {
          graph: ground.graph,
          values: Object.fromEntries(ground.values),
        },
      });
      ctx.scene.world.add(entity, Terrain, {
        terrain: made,
        ground,
        options,
      });
    },
  };
  const forest: ComponentCodec<{ trees: Float32Array; playRadius: number }> = {
    name: Forest.name,
    version: 1,
    write: (entity) => ({
      trees: Forest.trees[entity] as Float32Array,
      playRadius: Forest.playRadius[entity],
    }),
    read(data, entity, ctx) {
      ctx.scene.world.add(entity, Forest, data);
    },
  };
  return [
    ...sceneCodecs,
    lodCodec(lods),
    ...(physics ? [physicsCodec(physics)] : []),
    terrain,
    forest,
  ];
}

/**
 * Defines the baked rock in the store under RockUri, for the material of
 * the ground to be saved and loaded. Release the handle with the game.
 */
export function defineRock(
  store: ResourceStore,
  backend: RenderBackend,
  rock: GpuTexture,
): ResourceHandle<Texture> {
  return defineTexture(store, RockUri, {
    texture: rock,
    sampler: sharedSampler(backend),
    width: rock.dimensions.width,
    height: rock.dimensions.height ?? rock.dimensions.width,
    colorSpace: 'srgb',
  });
}

/**
 * Writes the forest as `path` of the store (`forest/forest.scene.json`)
 * and its binary: the files to write.
 */
export function saveTpsLevel(
  backend: RenderBackend,
  scene: Scene,
  store: ResourceStore,
  forest: Forest,
  path: string,
  physics?: ScenePhysics,
): Promise<ExportedFile[]> {
  const data = captureScene(scene, {
    store,
    uri: store.normalize(path),
    codecs: levelCodecs(backend, scene, forest.lods, physics),
    name: 'forest',
  });
  // Compact: the levels of detail of thousands of plants.
  return writeFdwScene(data, path, { indent: 0 });
}

/**
 * Loads the forest saved by saveTpsLevel: the nodes, the batches and their
 * levels of detail, the terrain, the bodies (straight under the root of
 * the scene). The baked rock must be defined in the store (defineRock).
 */
export async function loadTpsLevel(
  backend: RenderBackend,
  scene: Scene,
  store: ResourceStore,
  path: string,
  physics?: ScenePhysics,
): Promise<Forest> {
  installSceneIo(store);
  const lods = new SceneLods(scene, { hysteresis: 0.15 });
  const handle = store.load(SceneDataType, path);
  try {
    const instance = await instantiateScene(handle, scene, {
      store,
      codecs: levelCodecs(backend, scene, lods, physics),
      wrap: false,
    });
    const { Terrain, Forest } = levelComponents(scene);
    const root = scene.find('forest');
    const terrainNode = scene.find('terrain');
    if (!root || !terrainNode || !Forest.has(root.entity))
      throw new Error(`${path} is not a forest`);
    const terrain = Terrain.terrain[terrainNode.entity] as Terrain;
    const trees = Forest.trees[root.entity] as Float32Array;
    return {
      root,
      terrain,
      lods,
      trees,
      treeCount: trees.length / 3,
      playRadius: Forest.playRadius[root.entity],
      heightAt: terrain.heightAt,
      destroy: () => {
        instance.dispose();
        lods.destroy();
        terrain.destroy();
      },
    };
  } catch (e) {
    lods.destroy();
    throw e;
  } finally {
    handle.release();
  }
}
