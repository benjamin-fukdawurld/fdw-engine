import type { Camera } from '@fdw/engine-core';
import { TransformLayout } from '@fdw/engine-core';
import type { Scheduler } from '../systems/Scheduler';
import { Node } from './Node';
import { NodeFlags, Scene } from './Scene';

/** A level of detail: what it draws, and up to which distance. */
export interface LodLevel {
  // The nodes drawn at this level, with their descendants: nodes, or
  // entities (those of Scene.createBatch).
  readonly nodes: readonly (Node | number)[];
  // The distance from the camera up to which this level is drawn (the
  // next one takes over beyond), for a vertical field of view of
  // SceneLods.referenceFov. Beyond the last level, nothing is drawn.
  readonly maxDistance: number;
}

/** Options of SceneLods. */
export interface SceneLodsOptions {
  // The field of view the distances are given for, in degrees: a narrower
  // one (a zoom) draws finer levels further. Default 60.
  readonly referenceFov?: number;
  // How much a distance must pass a boundary to change level, as a share
  // of the boundary: no flicker at the boundaries. Default 0.1.
  readonly hysteresis?: number;
}

/** Options of SceneLods.install. */
export interface SceneLodsInstallOptions {
  readonly name?: string;
  readonly before?: readonly string[];
  readonly after?: readonly string[];
}

const None = -1;
const { world: World0, stride } = TransformLayout;

// The levels of a group: the renderers of each, their boundary.
interface Levels {
  readonly renderers: readonly Uint32Array[];
  readonly maxDistances: Float64Array;
}

/**
 * Levels of detail: groups of nodes drawn one at a time, chosen by their
 * distance from a camera. A component of the entity placing the group
 * (`lod`: its levels, the current one); a system choosing the levels, for
 * the main camera: the shadow maps and the occlusion culling see the same
 * levels. The other levels are left out of the queries by a flag of their
 * renderers (NodeFlags.Culled), without invalidating their transforms nor
 * their place in the indices: switching costs a few writes.
 *
 * Levels sharing their meshes across groups are instanced: 2000 trees of
 * three levels draw a few instanced calls per level.
 *
 * @example
 * ```ts
 * const lods = new SceneLods(scene);
 * lods.add(tree, [
 *   { nodes: [tree.children[0]], maxDistance: 20 },
 *   { nodes: [tree.children[1]], maxDistance: 80 },
 *   { nodes: [tree.children[2]], maxDistance: 300 },
 * ]);
 * lods.install(scheduler, camera); // or lods.update(camera) at each frame
 * ```
 */
export class SceneLods {
  /** The component of the groups: their levels, the level drawn (-1: none). */
  readonly Lod;
  /** Multiplies the distances of the levels: below 1, coarser levels sooner. */
  bias = 1;
  readonly referenceFov: number;
  readonly hysteresis: number;

  private readonly _query;
  private readonly _unsubscribe: () => void;

  constructor(
    readonly scene: Scene,
    options: SceneLodsOptions = {},
  ) {
    this.referenceFov = options.referenceFov ?? 60;
    this.hysteresis = options.hysteresis ?? 0.1;
    this.Lod = scene.world.defineComponent('lod', {
      levels: 'ref',
      current: 'i8',
    });
    this._query = scene.world.query(this.Lod);
    // A group removed shows its levels again, if they stay.
    this._unsubscribe = scene.world.onRemoved(this.Lod, (entity) => {
      const levels = this.Lod.levels[entity] as Levels | undefined;
      levels?.renderers.forEach((renderers) => this.cull(renderers, false));
    });
  }

  /**
   * Makes `at` (whose position places the group) the group of these
   * levels, finest first. Until the next update, the first level is drawn.
   * The renderers of the levels are those under their nodes now: add the
   * group again after changing them.
   */
  add(at: Node | number, levels: readonly LodLevel[]): void {
    const entity = at instanceof Node ? at.entity : at;
    const renderers = levels.map(({ nodes }) => {
      const found: number[] = [];
      for (const node of nodes) {
        this.collect(node instanceof Node ? node.entity : node, found);
      }
      return Uint32Array.from(found);
    });
    const data: Levels = {
      renderers,
      maxDistances: Float64Array.from(levels.map((l) => l.maxDistance)),
    };
    const { world } = this.scene;
    if (world.has(entity, this.Lod)) {
      world.remove(entity, this.Lod);
    }
    world.add(entity, this.Lod, { levels: data, current: 0 });
    renderers.forEach((list, i) => this.cull(list, i !== 0));
  }

  /** Removes a group: its levels are all drawn again. */
  remove(at: Node | number): void {
    const entity = at instanceof Node ? at.entity : at;
    if (this.scene.world.has(entity, this.Lod)) {
      this.scene.world.remove(entity, this.Lod);
    }
  }

  /** The level a group draws: 0 the finest, -1 none (too far). */
  level(at: Node | number): number {
    return this.Lod.current[at instanceof Node ? at.entity : at];
  }

  /**
   * Chooses the level of every group for a camera: by the distance of the
   * group from it, scaled by its field of view.
   */
  update(camera: Camera): void {
    const projection = camera.projection;
    // A narrower field of view magnifies: the distance counts as less.
    const zoom =
      projection.type === 'perspective'
        ? Math.tan((projection.fov * Math.PI) / 360) /
          Math.tan((this.referenceFov * Math.PI) / 360)
        : 1;
    const scale = zoom / this.bias;
    const { x, y, z } = camera.position;
    const { Lod, scene } = this;
    const { levels, current } = Lod;
    const data = scene.transforms.data;
    const h = this.hysteresis;
    for (const entity of this._query.entities) {
      scene.updateWorld(entity);
      const o = entity * stride + World0;
      const dx = data[o + 12] - x;
      const dy = data[o + 13] - y;
      const dz = data[o + 14] - z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz) * scale;
      const group = levels[entity] as Levels;
      const now = current[entity];
      // The boundaries of the finer levels are crossed outwards at
      // (1 + h), those of the coarser ones inwards at (1 - h).
      let next = None;
      const bounds = group.maxDistances;
      for (let i = 0; i < bounds.length; i++) {
        const boundary = bounds[i] * (now < 0 || i >= now ? 1 + h : 1 - h);
        if (distance < boundary) {
          next = i;
          break;
        }
      }
      if (next !== now) {
        if (now >= 0) {
          this.cull(group.renderers[now], true);
        }
        if (next >= 0) {
          this.cull(group.renderers[next], false);
        }
        current[entity] = next;
      }
    }
  }

  /**
   * Chooses the levels at each frame, for `camera`, in the render phase
   * (before the systems listed after it, the rendering).
   */
  install(
    scheduler: Scheduler,
    camera: Camera,
    options: SceneLodsInstallOptions = {},
  ): void {
    scheduler.add(options.name ?? 'lod', () => this.update(camera), {
      phase: 'render',
      before: options.before,
      after: options.after,
    });
  }

  /** Stops following the removals of the groups. */
  destroy(): void {
    this._unsubscribe();
  }

  // The renderers of a branch.
  private collect(entity: number, out: number[]): void {
    const { scene } = this;
    if (scene.MeshRenderer.has(entity)) {
      out.push(entity);
    }
    for (
      let child = scene.Hierarchy.first[entity];
      child !== None;
      child = scene.Hierarchy.next[child]
    ) {
      this.collect(child, out);
    }
  }

  private cull(renderers: Uint32Array, culled: boolean): void {
    const { flags } = this.scene.NodeState;
    const { world } = this.scene;
    for (const entity of renderers) {
      if (!world.isAlive(entity)) {
        continue;
      }
      flags[entity] = culled
        ? flags[entity] | NodeFlags.Culled
        : flags[entity] & ~NodeFlags.Culled;
    }
  }
}

/**
 * The groups of levels of detail of a branch, by the names of their nodes:
 * the children named `<name>_LOD0`, `<name>_LOD1`… of a node (the
 * convention of modeling tools and engines) are its levels, finest first.
 */
export function findLodGroups(
  root: Node,
): { readonly group: Node; readonly levels: readonly Node[] }[] {
  const groups: { group: Node; levels: Node[] }[] = [];
  root.traverse((node) => {
    const levels = node.children
      .map((child) => ({ child, level: /_LOD(\d+)$/.exec(child.name)?.[1] }))
      .filter((entry) => entry.level !== undefined)
      .sort((a, b) => Number(a.level) - Number(b.level))
      .map((entry) => entry.child);
    if (levels.length > 0) {
      groups.push({ group: node, levels });
    }
  });
  return groups;
}
