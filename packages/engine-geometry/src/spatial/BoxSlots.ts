import { Aabb } from '../volumes/Aabb';
import type { Ray } from '../volumes/Ray';

// The items of an index and their bounds: one slot per item, the boxes flat
// in a Float64Array (min x, y, z, max x, y, z per slot), the slot of an item
// in a map. Freed slots are reused.

export class BoxSlots<T> {
  items: (T | undefined)[] = [];
  boxes = new Float64Array(6 * 64);
  private readonly _slots = new Map<T, number>();
  private readonly _free: number[] = [];

  get size(): number {
    return this._slots.size;
  }

  slotOf(item: T): number | undefined {
    return this._slots.get(item);
  }

  add(item: T, bounds: Aabb): number {
    let slot = this._free.pop();
    if (slot === undefined) {
      slot = this.items.length;
      this.items.push(undefined);
      if (6 * this.items.length > this.boxes.length) {
        const grown = new Float64Array(this.boxes.length * 2);
        grown.set(this.boxes);
        this.boxes = grown;
      }
    }
    this.items[slot] = item;
    this._slots.set(item, slot);
    this.set(slot, bounds);
    return slot;
  }

  set(slot: number, { min, max }: Aabb): void {
    const o = slot * 6;
    this.boxes[o] = min[0];
    this.boxes[o + 1] = min[1];
    this.boxes[o + 2] = min[2];
    this.boxes[o + 3] = max[0];
    this.boxes[o + 4] = max[1];
    this.boxes[o + 5] = max[2];
  }

  /** Frees the slot of an item; returns it, or undefined. */
  remove(item: T): number | undefined {
    const slot = this._slots.get(item);
    if (slot !== undefined) {
      this._slots.delete(item);
      this.items[slot] = undefined;
      this._free.push(slot);
    }
    return slot;
  }

  clear(): void {
    this.items = [];
    this._slots.clear();
    this._free.length = 0;
  }

  /** The box of a slot, written into `out`. */
  read(slot: number, out: Aabb): Aabb {
    const o = slot * 6;
    const b = this.boxes;
    out.min[0] = b[o];
    out.min[1] = b[o + 1];
    out.min[2] = b[o + 2];
    out.max[0] = b[o + 3];
    out.max[1] = b[o + 4];
    out.max[2] = b[o + 5];
    return out;
  }

  /** Whether the box of a slot intersects a box. */
  intersects(slot: number, box: Aabb): boolean {
    const o = slot * 6;
    const b = this.boxes;
    return (
      b[o] <= box.max[0] &&
      b[o + 3] >= box.min[0] &&
      b[o + 1] <= box.max[1] &&
      b[o + 4] >= box.min[1] &&
      b[o + 2] <= box.max[2] &&
      b[o + 5] >= box.min[2]
    );
  }

  /** The distance along a ray to the box of a slot (slab method), or -1. */
  raycast(slot: number, ray: Ray): number {
    return rayBox(ray, this.boxes, slot * 6);
  }
}

/**
 * The distance along a ray to a box stored flat at an offset of an array
 * (min x, y, z, max x, y, z): 0 when the ray starts inside, -1 when it
 * misses.
 */
export function rayBox(
  ray: Ray,
  box: ArrayLike<number>,
  offset: number,
): number {
  let near = 0;
  let far = Infinity;
  for (let axis = 0; axis < 3; axis++) {
    const d = ray.direction[axis];
    const o = ray.origin[axis];
    const min = box[offset + axis];
    const max = box[offset + 3 + axis];
    if (d === 0) {
      if (o < min || o > max) {
        return -1;
      }
      continue;
    }
    let t0 = (min - o) / d;
    let t1 = (max - o) / d;
    if (t0 > t1) {
      const swap = t0;
      t0 = t1;
      t1 = swap;
    }
    if (t0 > near) {
      near = t0;
    }
    if (t1 < far) {
      far = t1;
    }
    if (near > far) {
      return -1;
    }
  }
  return near;
}

/**
 * A priority queue of numbers keyed by distance, nearest first: the
 * best-first walks of the raycasts.
 */
export class DistanceQueue {
  private _keys: number[] = [];
  private _values: number[] = [];

  get length(): number {
    return this._keys.length;
  }

  clear(): void {
    this._keys.length = 0;
    this._values.length = 0;
  }

  push(key: number, value: number): void {
    const keys = this._keys;
    const values = this._values;
    let i = keys.length;
    keys.push(key);
    values.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) {
        break;
      }
      keys[i] = keys[parent];
      values[i] = values[parent];
      i = parent;
    }
    keys[i] = key;
    values[i] = value;
  }

  /** The key of the nearest entry. */
  peekKey(): number {
    return this._keys[0];
  }

  /** Removes the nearest entry and returns its value. */
  pop(): number {
    const keys = this._keys;
    const values = this._values;
    const top = values[0];
    const lastKey = keys.pop() as number;
    const lastValue = values.pop() as number;
    const n = keys.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        if (left >= n) {
          break;
        }
        const right = left + 1;
        const child = right < n && keys[right] < keys[left] ? right : left;
        if (keys[child] >= lastKey) {
          break;
        }
        keys[i] = keys[child];
        values[i] = values[child];
        i = child;
      }
      keys[i] = lastKey;
      values[i] = lastValue;
    }
    return top;
  }
}
