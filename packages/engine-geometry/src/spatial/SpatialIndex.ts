import type { Aabb } from '../volumes/Aabb';
import type { Frustum } from '../volumes/Frustum';
import type { Ray } from '../volumes/Ray';
import type { Volume } from '../volumes/Volume';

/**
 * Items indexed by their bounds, for spatial queries. It knows nothing of
 * the items: a scene graph, an ECS, a physics engine or an application can
 * index their own objects (nodes, entity ids…).
 */
export interface SpatialIndex<T> {
  /** The number of items. */
  readonly size: number;
  /** Adds an item; its bounds are copied. */
  insert(item: T, bounds: Aabb): void;
  /** Moves an item to new bounds. */
  update(item: T, bounds: Aabb): void;
  /** Removes an item; false when it was not indexed. */
  remove(item: T): boolean;
  has(item: T): boolean;
  clear(): void;
  /**
   * The items whose bounds may touch the frustum. `inside` is true when
   * their bounds are entirely inside: finer tests can be skipped.
   */
  queryFrustum(
    frustum: Frustum,
    visit: (item: T, inside: boolean) => void,
  ): void;
  /**
   * The items whose bounds intersect a volume (any Volume: its bounds first,
   * then intersects()). `visit` returns false to stop the query.
   */
  queryVolume(volume: Volume, visit: (item: T) => boolean | void): void;
  /**
   * The items whose bounds the ray crosses, nearest first, with the distance
   * to their bounds. The exact test (the triangles, the item's own volume)
   * is the caller's. `visit` returns false to stop the query.
   */
  raycast(
    ray: Ray,
    visit: (item: T, distance: number) => boolean | void,
    maxDistance?: number,
  ): void;
  /** The bounds of all the items, written into `out` (empty without items). */
  bounds(out: Aabb): Aabb;
}
