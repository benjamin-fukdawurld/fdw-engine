import { Aabb, Capsule } from '@fdw/engine-geometry';
import { buildNavMesh, type NavMesh } from '@fdw/engine-navigation';

/** What the navigation of the forest is made from. */
export interface ForestGround {
  // The firs: x, z, radius of the trunk.
  readonly trees: Float32Array;
  readonly playRadius: number;
  heightAt(x: number, z: number): number;
}

/** The size of the largest enemy the mesh is made for: the demon. */
export const NavAgentRadius = 0.55;

/**
 * The navigation mesh of the forest: its ground (the height of the
 * terrain), the trunks of the play area as capsules, the slopes past it
 * too steep to walk. Cells of half a meter, the floors of a polygon within
 * 30 cm of each other: a few thousand polygons for the play area of 100 m.
 */
export function forestNavMesh(forest: ForestGround): NavMesh {
  const extent = forest.playRadius + 6;
  const trunks: Capsule[] = [];
  const { trees } = forest;
  for (let i = 0; i < trees.length; i += 3) {
    const [x, z, radius] = [trees[i], trees[i + 1], trees[i + 2]];
    if (Math.abs(x) > extent + 1 || Math.abs(z) > extent + 1) continue;
    const y = forest.heightAt(x, z);
    // As the capsule of the physics: 4 m of trunk from the ground.
    trunks.push(new Capsule([x, y - 0.5, z], [x, y + 4, z], radius));
  }
  return buildNavMesh({
    bounds: new Aabb([-extent, -100, -extent], [extent, 100, extent]),
    volumes: trunks,
    ground: forest.heightAt,
    cellSize: 0.5,
    agentRadius: NavAgentRadius,
    agentHeight: 1.8,
    maxClimb: 0.4,
    maxSlope: (40 * Math.PI) / 180,
    heightTolerance: 0.3,
  });
}
