import { Aabb } from '../volumes/Aabb';
import type { Frustum } from '../volumes/Frustum';
import { intersects } from '../volumes/intersections';
import type { Ray } from '../volumes/Ray';
import type { Volume } from '../volumes/Volume';
import { BoxSlots, DistanceQueue, rayBox } from './BoxSlots';
import type { SpatialIndex } from './SpatialIndex';

// A loose octree: each cell accepts the items that fit in its loose bounds,
// the cell grown by a factor 2 (its center ± twice its half size). An item
// is stored in a single cell, as deep as its size allows: no item is split,
// and an item that moves a little stays in its cell.

class Cell {
  children?: (Cell | undefined)[];
  // The slots of the items stored in this cell.
  readonly items: number[] = [];
  // The items in this cell and its descendants.
  count = 0;
  // The loose bounds, flat: min x, y, z, max x, y, z.
  readonly loose = new Float64Array(6);

  constructor(
    readonly x: number,
    readonly y: number,
    readonly z: number,
    readonly half: number,
    public parent: Cell | undefined,
    public octant: number
  ) {
    const loose = 2 * half;
    const l = this.loose;
    l[0] = x - loose;
    l[1] = y - loose;
    l[2] = z - loose;
    l[3] = x + loose;
    l[4] = y + loose;
    l[5] = z + loose;
  }

  // Whether a box (flat, at an offset) is inside the loose bounds.
  contains(boxes: Float64Array, o: number): boolean {
    const l = this.loose;
    return (
      boxes[o] >= l[0] &&
      boxes[o + 1] >= l[1] &&
      boxes[o + 2] >= l[2] &&
      boxes[o + 3] <= l[3] &&
      boxes[o + 4] <= l[4] &&
      boxes[o + 5] <= l[5]
    );
  }

  intersects(box: Aabb): boolean {
    const l = this.loose;
    return (
      l[0] <= box.max[0] &&
      l[3] >= box.min[0] &&
      l[1] <= box.max[1] &&
      l[4] >= box.min[1] &&
      l[2] <= box.max[2] &&
      l[5] >= box.min[2]
    );
  }
}

export interface OctreeOptions {
  /**
   * The cells are split when they hold more items than this, and are deep
   * enough. Default 8.
   */
  readonly splitThreshold?: number;
  /**
   * The half size of the smallest cells. Defaults to the half size of the
   * first root divided by 256 (8 levels).
   */
  readonly minHalfSize?: number;
}

const scratch = new Aabb();

/**
 * A loose octree: insertion and moves in O(depth), cells created and
 * removed as needed, a root that grows when an item is outside of it.
 */
export class Octree<T> implements SpatialIndex<T> {
  private readonly _slots = new BoxSlots<T>();
  // The cell of each slot, and the index of the slot in the items of the
  // cell.
  private _cellOf: (Cell | undefined)[] = [];
  private _indexInCell: number[] = [];
  private _root?: Cell;
  private readonly _splitThreshold: number;
  private _minHalfSize?: number;
  private readonly _queue = new DistanceQueue();

  constructor(options: OctreeOptions = {}) {
    this._splitThreshold = options.splitThreshold ?? 8;
    this._minHalfSize = options.minHalfSize;
  }

  get size(): number {
    return this._slots.size;
  }

  /** The number of cells, for the tests and the statistics. */
  get cellCount(): number {
    let count = 0;
    const visit = (cell: Cell) => {
      count++;
      cell.children?.forEach((child) => child && visit(child));
    };
    if (this._root) {
      visit(this._root);
    }
    return count;
  }

  insert(item: T, bounds: Aabb): void {
    if (this._slots.slotOf(item) !== undefined) {
      throw new Error('The item is already indexed: use update()');
    }
    const slot = this._slots.add(item, bounds);
    this.place(slot, this.rootFor(slot));
  }

  /**
   * Indexes many items at once: the root is sized for all of them first,
   * so that it does not grow while they are inserted. The entries are read
   * once, their bounds copied: an iterator can reuse the same box.
   */
  insertAll(entries: Iterable<readonly [T, Aabb]>): void {
    if (this._root) {
      for (const [item, bounds] of entries) {
        this.insert(item, bounds);
      }
      return;
    }
    // An empty tree: built top-down, each level splitting its items among
    // the children in one pass, instead of moving them down at each split.
    const all = Aabb.empty();
    const slots: number[] = [];
    for (const [item, bounds] of entries) {
      if (this._slots.slotOf(item) !== undefined) {
        throw new Error('The item is already indexed: use update()');
      }
      all.union(bounds);
      slots.push(this._slots.add(item, bounds));
    }
    if (slots.length === 0) {
      return;
    }
    const center = all.center();
    const half = all.halfExtents();
    const root = this.createRoot(
      center[0],
      center[1],
      center[2],
      Math.max(half[0], half[1], half[2], 1e-6)
    );
    this.build(root, slots);
  }

  private build(cell: Cell, slots: number[]): void {
    const boxes = this._slots.boxes;
    // The subtree holds all these items: no count to propagate per item.
    cell.count = slots.length;
    if (
      slots.length <= this._splitThreshold ||
      cell.half / 2 < (this._minHalfSize as number)
    ) {
      for (const slot of slots) {
        this.storeHere(slot, cell);
      }
      return;
    }
    const groups: number[][] = [[], [], [], [], [], [], [], []];
    for (const slot of slots) {
      const child = this.childFor(cell, boxes, slot * 6);
      if (child) {
        groups[child.octant].push(slot);
      } else {
        this.storeHere(slot, cell);
      }
    }
    groups.forEach((group, octant) => {
      const child = cell.children?.[octant];
      if (child && group.length > 0) {
        this.build(child, group);
      }
    });
  }

  update(item: T, bounds: Aabb): void {
    const slot = this._slots.slotOf(item);
    if (slot === undefined) {
      throw new Error('The item is not indexed: use insert()');
    }
    this._slots.set(slot, bounds);
    const boxes = this._slots.boxes;
    const cell = this._cellOf[slot] as Cell;
    if (cell.contains(boxes, slot * 6)) {
      // Still in its cell: the usual case of an item that moves a little.
      return;
    }
    // Up to the first cell containing it, then down from there.
    let target: Cell | undefined = cell.parent;
    while (target && !target.contains(boxes, slot * 6)) {
      target = target.parent;
    }
    this.detach(slot);
    this.place(slot, target ?? this.rootFor(slot));
    this.prune(cell);
  }

  remove(item: T): boolean {
    const slot = this._slots.slotOf(item);
    if (slot === undefined) {
      return false;
    }
    this.unstore(slot);
    this._slots.remove(item);
    return true;
  }

  has(item: T): boolean {
    return this._slots.slotOf(item) !== undefined;
  }

  clear(): void {
    this._slots.clear();
    this._cellOf = [];
    this._indexInCell = [];
    this._root = undefined;
  }

  queryFrustum(
    frustum: Frustum,
    visit: (item: T, inside: boolean) => void
  ): void {
    if (!this._root) {
      return;
    }
    const { items, boxes } = this._slots;
    const walk = (cell: Cell, inside: boolean) => {
      if (!inside) {
        const classification = frustum.classifyBounds(cell.loose, 0);
        if (classification === 'outside') {
          return;
        }
        inside = classification === 'inside';
      }
      for (const slot of cell.items) {
        if (inside) {
          visit(items[slot] as T, true);
        } else {
          const classification = frustum.classifyBounds(boxes, slot * 6);
          if (classification !== 'outside') {
            visit(items[slot] as T, classification === 'inside');
          }
        }
      }
      if (cell.children) {
        for (const child of cell.children) {
          if (child) {
            walk(child, inside);
          }
        }
      }
    };
    walk(this._root, false);
  }

  queryVolume(volume: Volume, visit: (item: T) => boolean | void): void {
    if (!this._root) {
      return;
    }
    const bounds = volume.bounds(new Aabb());
    const slots = this._slots;
    const walk = (cell: Cell): boolean => {
      if (!cell.intersects(bounds)) {
        return true;
      }
      for (const slot of cell.items) {
        if (
          slots.intersects(slot, bounds) &&
          intersects(slots.read(slot, scratch), volume) &&
          visit(slots.items[slot] as T) === false
        ) {
          return false;
        }
      }
      if (cell.children) {
        for (const child of cell.children) {
          if (child && !walk(child)) {
            return false;
          }
        }
      }
      return true;
    };
    walk(this._root);
  }

  raycast(
    ray: Ray,
    visit: (item: T, distance: number) => boolean | void,
    maxDistance = Infinity
  ): void {
    if (!this._root) {
      return;
    }
    // Best first: cells and items in one queue, by the distance to their
    // bounds. A cell is never farther than the items it holds.
    const queue = this._queue;
    queue.clear();
    const cells: Cell[] = [];
    const pushCell = (cell: Cell) => {
      const distance = rayBox(ray, cell.loose, 0);
      if (distance >= 0 && distance <= maxDistance) {
        cells.push(cell);
        queue.push(distance, -cells.length);
      }
    };
    pushCell(this._root);
    while (queue.length > 0) {
      const distance = queue.peekKey();
      const value = queue.pop();
      if (value >= 0) {
        if (visit(this._slots.items[value] as T, distance) === false) {
          return;
        }
        continue;
      }
      const cell = cells[-value - 1];
      for (const slot of cell.items) {
        const d = this._slots.raycast(slot, ray);
        if (d >= 0 && d <= maxDistance) {
          queue.push(d, slot);
        }
      }
      cell.children?.forEach((child) => child && pushCell(child));
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

  // --- Cells -------------------------------------------------------------------

  private createRoot(x: number, y: number, z: number, half: number): Cell {
    this._root = new Cell(x, y, z, half, undefined, 0);
    this._minHalfSize ??= half / 256;
    return this._root;
  }

  // The root, grown until it contains the box of a slot.
  private rootFor(slot: number): Cell {
    const boxes = this._slots.boxes;
    const o = slot * 6;
    if (!this._root) {
      const half = Math.max(
        (boxes[o + 3] - boxes[o]) / 2,
        (boxes[o + 4] - boxes[o + 1]) / 2,
        (boxes[o + 5] - boxes[o + 2]) / 2,
        1e-6
      );
      return this.createRoot(
        (boxes[o] + boxes[o + 3]) / 2,
        (boxes[o + 1] + boxes[o + 4]) / 2,
        (boxes[o + 2] + boxes[o + 5]) / 2,
        half
      );
    }
    let root = this._root;
    while (!root.contains(boxes, o)) {
      // Twice as large, towards the box; the old root is one of its children.
      const toward = (axis: number, center: number) =>
        (boxes[o + axis] + boxes[o + 3 + axis]) / 2 >= center ? 1 : -1;
      const dx = toward(0, root.x);
      const dy = toward(1, root.y);
      const dz = toward(2, root.z);
      const grown = new Cell(
        root.x + dx * root.half,
        root.y + dy * root.half,
        root.z + dz * root.half,
        root.half * 2,
        undefined,
        0
      );
      grown.children = new Array(8).fill(undefined);
      const octant = (dx < 0 ? 1 : 0) | (dy < 0 ? 2 : 0) | (dz < 0 ? 4 : 0);
      grown.children[octant] = root;
      grown.count = root.count;
      root.parent = grown;
      root.octant = octant;
      root = grown;
    }
    this._root = root;
    return root;
  }

  // Stores a slot in a cell containing it, or in the deepest descendant
  // that does, splitting the cells that hold too many items.
  private place(slot: number, start: Cell): void {
    const boxes = this._slots.boxes;
    const o = slot * 6;
    let cell = start;
    for (;;) {
      const half = cell.half / 2;
      const canDescend = half >= (this._minHalfSize as number);
      if (!cell.children) {
        if (!canDescend || cell.items.length < this._splitThreshold) {
          break;
        }
        this.split(cell);
      }
      const child = canDescend ? this.childFor(cell, boxes, o) : undefined;
      if (!child) {
        break;
      }
      cell = child;
    }
    this.store(slot, cell);
  }

  // The child of a cell for a box, created if needed, if the box fits in it.
  private childFor(
    cell: Cell,
    boxes: Float64Array,
    o: number
  ): Cell | undefined {
    const octant =
      ((boxes[o] + boxes[o + 3]) / 2 >= cell.x ? 1 : 0) |
      ((boxes[o + 1] + boxes[o + 4]) / 2 >= cell.y ? 2 : 0) |
      ((boxes[o + 2] + boxes[o + 5]) / 2 >= cell.z ? 4 : 0);
    const half = cell.half / 2;
    let child = cell.children?.[octant];
    if (!child) {
      child = new Cell(
        cell.x + (octant & 1 ? half : -half),
        cell.y + (octant & 2 ? half : -half),
        cell.z + (octant & 4 ? half : -half),
        half,
        cell,
        octant
      );
      if (!child.contains(boxes, o)) {
        return undefined;
      }
      cell.children ??= new Array(8).fill(undefined);
      cell.children[octant] = child;
      return child;
    }
    return child.contains(boxes, o) ? child : undefined;
  }

  // Moves down the items of a full cell that fit in its children. The
  // children array stays, even empty: a cell full of large items is not
  // split again at each insertion.
  private split(cell: Cell): void {
    cell.children = new Array(8).fill(undefined);
    const boxes = this._slots.boxes;
    for (const slot of [...cell.items]) {
      const child = this.childFor(cell, boxes, slot * 6);
      if (child) {
        this.detach(slot);
        this.place(slot, child);
      }
    }
  }

  private store(slot: number, cell: Cell): void {
    this.storeHere(slot, cell);
    for (let c: Cell | undefined = cell; c; c = c.parent) {
      c.count++;
    }
  }

  // Stores a slot in a cell, without counting it in the ancestors.
  private storeHere(slot: number, cell: Cell): void {
    this._cellOf[slot] = cell;
    this._indexInCell[slot] = cell.items.length;
    cell.items.push(slot);
  }

  // Takes a slot out of its cell; the cell stays, even empty.
  private detach(slot: number): void {
    const cell = this._cellOf[slot] as Cell;
    const index = this._indexInCell[slot];
    const last = cell.items.pop() as number;
    if (last !== slot) {
      cell.items[index] = last;
      this._indexInCell[last] = index;
    }
    this._cellOf[slot] = undefined;
    for (let c: Cell | undefined = cell; c; c = c.parent) {
      c.count--;
    }
  }

  private unstore(slot: number): void {
    const cell = this._cellOf[slot] as Cell;
    this.detach(slot);
    this.prune(cell);
  }

  // Removes a cell left empty, and its ancestors left empty.
  private prune(cell: Cell): void {
    let empty: Cell | undefined = cell;
    while (empty && empty.count === 0 && empty.parent) {
      const parent: Cell = empty.parent;
      const siblings = parent.children as (Cell | undefined)[];
      if (siblings[empty.octant] === empty) {
        siblings[empty.octant] = undefined;
      }
      if (siblings.every((child) => !child)) {
        parent.children = undefined;
      }
      empty = parent;
    }
  }
}
