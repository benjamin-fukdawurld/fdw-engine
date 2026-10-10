import { Aabb } from '../volumes/Aabb';
import type { Frustum } from '../volumes/Frustum';
import { intersects } from '../volumes/intersections';
import type { Ray } from '../volumes/Ray';
import type { Volume } from '../volumes/Volume';
import { BoxSlots } from './BoxSlots';
import type { SpatialIndex } from './SpatialIndex';

const scratch = new Aabb();

/**
 * Every item tested by every query: the reference of the tests, and the
 * right choice below a few hundred items.
 */
export class LinearIndex<T> implements SpatialIndex<T> {
  private readonly _slots = new BoxSlots<T>();

  get size(): number {
    return this._slots.size;
  }

  insert(item: T, bounds: Aabb): void {
    if (this._slots.slotOf(item) !== undefined) {
      throw new Error('The item is already indexed: use update()');
    }
    this._slots.add(item, bounds);
  }

  update(item: T, bounds: Aabb): void {
    const slot = this._slots.slotOf(item);
    if (slot === undefined) {
      throw new Error('The item is not indexed: use insert()');
    }
    this._slots.set(slot, bounds);
  }

  remove(item: T): boolean {
    return this._slots.remove(item) !== undefined;
  }

  has(item: T): boolean {
    return this._slots.slotOf(item) !== undefined;
  }

  clear(): void {
    this._slots.clear();
  }

  queryFrustum(
    frustum: Frustum,
    visit: (item: T, inside: boolean) => void
  ): void {
    const { items, boxes } = this._slots;
    for (let slot = 0; slot < items.length; slot++) {
      const item = items[slot];
      if (item === undefined) {
        continue;
      }
      const classification = frustum.classifyBounds(boxes, slot * 6);
      if (classification !== 'outside') {
        visit(item, classification === 'inside');
      }
    }
  }

  queryVolume(volume: Volume, visit: (item: T) => boolean | void): void {
    const bounds = volume.bounds(new Aabb());
    const { items } = this._slots;
    for (let slot = 0; slot < items.length; slot++) {
      const item = items[slot];
      if (
        item !== undefined &&
        this._slots.intersects(slot, bounds) &&
        intersects(this._slots.read(slot, scratch), volume) &&
        visit(item) === false
      ) {
        return;
      }
    }
  }

  raycast(
    ray: Ray,
    visit: (item: T, distance: number) => boolean | void,
    maxDistance = Infinity
  ): void {
    const hits: { item: T; distance: number }[] = [];
    const { items } = this._slots;
    for (let slot = 0; slot < items.length; slot++) {
      const item = items[slot];
      if (item === undefined) {
        continue;
      }
      const distance = this._slots.raycast(slot, ray);
      if (distance >= 0 && distance <= maxDistance) {
        hits.push({ item, distance });
      }
    }
    hits.sort((a, b) => a.distance - b.distance);
    for (const { item, distance } of hits) {
      if (visit(item, distance) === false) {
        return;
      }
    }
  }

  bounds(out: Aabb): Aabb {
    out.makeEmpty();
    const { items } = this._slots;
    for (let slot = 0; slot < items.length; slot++) {
      if (items[slot] !== undefined) {
        out.union(this._slots.read(slot, scratch));
      }
    }
    return out;
  }
}
