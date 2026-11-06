import { NavMesh } from './NavMesh';
import {
  assemble,
  bounded,
  buildRegion,
  settingsOf,
  type VoxelOptions,
} from './voxels';

/** Options of {@link buildNavMesh}. */
export type BuildNavMeshOptions = VoxelOptions;

/**
 * A navigation mesh of the volumes of a region: the region cut in columns
 * of `cellSize`, the solids of each column found by rays, the tops of the
 * solids with room above them for the agent kept as floors, linked to
 * their neighbors within a step, the floors closer to an edge than the
 * radius of the agent dropped; then the flat floors gathered in
 * rectangles (within `heightTolerance`), the polygons of the mesh.
 *
 * Everything walkable is in the mesh, the tops of the walls too when an
 * agent fits there: they are islands, not linked to the rest.
 *
 * @example
 * ```ts
 * const navMesh = buildNavMesh({
 *   bounds: new Aabb([-20, -1, -20], [20, 5, 20]),
 *   volumes: sceneVolumes(scene),
 *   agentRadius: 0.4,
 * });
 * ```
 */
export function buildNavMesh(options: BuildNavMeshOptions): NavMesh {
  const s = settingsOf(options);
  const region = buildRegion(
    s,
    { x0: 0, z0: 0, x1: s.columnsX, z1: s.columnsZ },
    0,
    bounded(options.volumes),
  );
  return new NavMesh(assemble(s, [region]));
}
