import {
  ModelType,
  TextureType,
  type Model,
  type Texture,
  type TextureOptions,
} from '@fdw/engine-assets';
import type { ResourceHandle, ResourceStore } from '@fdw/engine-resources';
import type { ForestModels } from './forest';

/** The models and textures of the TPS demo, loaded. */
export interface TpsAssets extends ForestModels {
  readonly hero: Model;
  readonly orc: Model;
  readonly demon: Model;
}

/** What loadTpsAssets returns: the progress, then the assets. */
export interface TpsLoading {
  /** From 0 to 1, the files and their dependencies (textures). */
  readonly progress: () => number;
  readonly ready: Promise<TpsAssets>;
  /** Releases the assets. */
  release(): void;
}

/**
 * Loads the files of the demo from `folder` of the store (glTF models and
 * JPEG textures, see tools/assets): the store needs the glTF loader and an
 * image codec, and the render backend.
 */
export function loadTpsAssets(
  resources: ResourceStore,
  folder = 'forest/',
): TpsLoading {
  const scope = resources.scope('tps');
  const model = (name: string) =>
    scope.load<Model>(ModelType, `${folder}${name}.glb`);
  const texture = (name: string, colorSpace: 'srgb' | 'linear') =>
    scope.load<Texture, TextureOptions>(
      TextureType,
      `${folder}forest_ground_${name}.jpg`,
      { options: { colorSpace } },
    );
  const handles = {
    fir: model('fir'),
    fern: model('fern'),
    grass: model('grass'),
    hero: model('hero'),
    orc: model('orc'),
    demon: model('demon'),
    color: texture('diff', 'srgb'),
    normal: texture('nor_gl', 'linear'),
    roughness: texture('rough', 'linear'),
  };
  const all = Object.values(handles) as ResourceHandle<unknown>[];
  const group = resources.group(all);
  return {
    progress: () => group.progress.value,
    ready: group.ready.then(() => ({
      fir: handles.fir.require(),
      fern: handles.fern.require(),
      grass: handles.grass.require(),
      hero: handles.hero.require(),
      orc: handles.orc.require(),
      demon: handles.demon.require(),
      ground: {
        color: handles.color.require().texture,
        normal: handles.normal.require().texture,
        roughness: handles.roughness.require().texture,
      },
    })),
    release: () => scope.dispose(),
  };
}
