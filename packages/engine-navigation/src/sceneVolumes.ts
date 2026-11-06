import { Aabb, type Volume } from '@fdw/engine-geometry';
import type { Node, QueryOptions, Scene } from '@fdw/engine-scene';

/** Options of {@link sceneVolumes}. */
export interface SceneVolumesOptions extends QueryOptions {
  /** Only within this box. Default: everything. */
  readonly bounds?: Aabb;
  /** Keeps a node (default: all): leave out the characters, the props. */
  readonly filter?: (node: Node) => boolean;
}

/**
 * The volumes of the renderers of a scene, in the world: the volume given
 * to `setMesh` when there is one, the bounds of the mesh otherwise. The
 * solids of {@link buildNavMesh}.
 */
export function sceneVolumes(
  scene: Scene,
  options: SceneVolumesOptions = {},
): Volume[] {
  const volumes: Volume[] = [];
  const bounds = options.bounds ?? scene.bounds(new Aabb());
  if (bounds.isEmpty()) {
    return volumes;
  }
  scene.queryVolumeEntities(
    bounds,
    (entity) => {
      if (options.filter && !options.filter(scene.node(entity))) {
        return;
      }
      const own = scene.MeshRenderer.volume[entity] as Volume | undefined;
      volumes.push(own ?? scene.bounds(new Aabb(), entity));
    },
    options,
  );
  return volumes;
}
