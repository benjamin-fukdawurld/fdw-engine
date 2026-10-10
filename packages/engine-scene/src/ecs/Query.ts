import type { ComponentStore } from './Component';

/** Excludes the entities that have a component from a query. */
export interface Not {
  readonly not: ComponentStore;
}

export const not = (component: ComponentStore): Not => ({ not: component });

export type QueryTerm = ComponentStore | Not;

/**
 * The entities that have some components and not others, kept up to date
 * as components are added and removed. Iterate it with `for…of`, or with
 * `entities` and `count` in the hot loops.
 *
 * Removing a component of the query while iterating moves the last entity
 * into the place of the removed one: iterate backwards to remove.
 */
export class Query {
  readonly all: readonly ComponentStore[];
  readonly none: readonly ComponentStore[];
  private _dense: Uint32Array;
  private _sparse: Int32Array;
  private _count = 0;

  /** @internal Created by World.query(). */
  constructor(terms: readonly QueryTerm[], capacity: number) {
    this.all = terms.filter((term): term is ComponentStore => !('not' in term));
    this.none = terms
      .filter((term): term is Not => 'not' in term)
      .map((term) => term.not);
    this._dense = new Uint32Array(Math.max(capacity, 1));
    this._sparse = new Int32Array(capacity).fill(-1);
  }

  get count(): number {
    return this._count;
  }

  /** The entities of the query, in no particular order. */
  get entities(): Uint32Array {
    return this._dense.subarray(0, this._count);
  }

  has(entity: number): boolean {
    return this._sparse[entity] >= 0;
  }

  *[Symbol.iterator](): IterableIterator<number> {
    for (let i = 0; i < this._count; i++) {
      yield this._dense[i];
    }
  }

  /** @internal Whether an entity matches the terms. */
  matches(entity: number): boolean {
    for (const component of this.all) {
      if (!component.has(entity)) {
        return false;
      }
    }
    for (const component of this.none) {
      if (component.has(entity)) {
        return false;
      }
    }
    return true;
  }

  /** @internal Adds or removes an entity after one of its components changed. */
  update(entity: number): void {
    const inside = this._sparse[entity] >= 0;
    const matches = this.matches(entity);
    if (matches && !inside) {
      if (this._count === this._dense.length) {
        const dense = new Uint32Array(this._dense.length * 2);
        dense.set(this._dense);
        this._dense = dense;
      }
      this._sparse[entity] = this._count;
      this._dense[this._count++] = entity;
    } else if (!matches && inside) {
      this.delete(entity);
    }
  }

  /** @internal */
  delete(entity: number): void {
    const position = this._sparse[entity];
    if (position < 0) {
      return;
    }
    const last = this._dense[--this._count];
    this._dense[position] = last;
    this._sparse[last] = position;
    this._sparse[entity] = -1;
  }

  /** @internal */
  grow(capacity: number): void {
    const sparse = new Int32Array(capacity).fill(-1);
    sparse.set(this._sparse);
    this._sparse = sparse;
  }
}
