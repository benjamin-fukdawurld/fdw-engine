import {
  Component,
  ComponentStore,
  ComponentValues,
  Schema,
} from './Component';
import { Query, QueryTerm } from './Query';

/** Called when an entity receives or loses a component. */
export type ComponentListener = (entity: number) => void;

// The names of the members of ComponentStore, which fields cannot take.
const reserved = new Set([
  'id',
  'name',
  'schema',
  'count',
  'entities',
  'has',
  'insert',
  'delete',
  'write',
  'grow',
]);

export interface WorldOptions {
  /** The number of entities the columns are first allocated for. Default 1024. */
  readonly capacity?: number;
}

/**
 * Entities and their components. An entity is an index in the columns of
 * the components: `Velocity.x[entity]`. The index of a destroyed entity is
 * reused, later; its generation then changes, which lets handles (the
 * nodes of a scene) detect that their entity is gone.
 */
export class World {
  private _capacity: number;
  private _generations: Uint32Array;
  private _alive: Uint8Array;
  // Free indices, reused in the order they were freed: the later, the
  // fewer mix-ups with stale entity numbers.
  private _free: number[] = [];
  private _freeHead = 0;
  private _next = 0;
  private _count = 0;
  private readonly _components: ComponentStore[] = [];
  private readonly _queries = new Map<string, Query>();
  // The queries involving each component, by component id.
  private readonly _queriesOf: Query[][] = [];
  private readonly _added: ComponentListener[][] = [];
  private readonly _removed: ComponentListener[][] = [];

  constructor({ capacity = 1024 }: WorldOptions = {}) {
    this._capacity = capacity;
    this._generations = new Uint32Array(capacity);
    this._alive = new Uint8Array(capacity);
  }

  /** The number of entities alive. */
  get count(): number {
    return this._count;
  }

  /** The number of entities the columns hold before growing. */
  get capacity(): number {
    return this._capacity;
  }

  /**
   * Defines a component: a column per field of its schema, for every
   * entity of the world.
   *
   * @example
   * ```ts
   * const Velocity = world.defineComponent('velocity', { x: 'f32', y: 'f32', z: 'f32' });
   * const Target = world.defineComponent('target', { entity: 'u32', weight: 'f32' });
   * const Path = world.defineComponent('path', { points: 'ref' });
   * ```
   */
  defineComponent<S extends Schema>(name: string, schema: S): Component<S> {
    for (const field of Object.keys(schema)) {
      if (reserved.has(field)) {
        throw new Error(`Component "${name}": "${field}" is a reserved name`);
      }
    }
    const component = new ComponentStore(
      this._components.length,
      name,
      schema,
      this._capacity
    );
    this._components.push(component);
    this._queriesOf.push([]);
    this._added.push([]);
    this._removed.push([]);
    return component as Component<S>;
  }

  create(): number {
    let entity: number;
    if (this._freeHead < this._free.length) {
      entity = this._free[this._freeHead++];
      if (this._freeHead > 1024 && this._freeHead * 2 > this._free.length) {
        this._free = this._free.slice(this._freeHead);
        this._freeHead = 0;
      }
    } else {
      if (this._next === this._capacity) {
        this.grow(this._capacity * 2);
      }
      entity = this._next++;
    }
    this._alive[entity] = 1;
    this._count++;
    // The queries made of exclusions only match an entity without component.
    for (const query of this._queries.values()) {
      if (query.all.length === 0) {
        query.update(entity);
      }
    }
    return entity;
  }

  /** Removes the components of an entity, then frees it. */
  destroy(entity: number): void {
    if (!this._alive[entity]) {
      return;
    }
    for (const component of this._components) {
      if (component.has(entity)) {
        this.remove(entity, component);
      }
    }
    for (const query of this._queries.values()) {
      query.delete(entity);
    }
    this._alive[entity] = 0;
    this._generations[entity]++;
    this._free.push(entity);
    this._count--;
  }

  isAlive(entity: number): boolean {
    return entity < this._next && this._alive[entity] === 1;
  }

  /** Incremented each time the entity is destroyed. */
  generation(entity: number): number {
    return this._generations[entity];
  }

  /** Gives a component to an entity, or writes its values if it has it. */
  add<S extends Schema>(
    entity: number,
    component: Component<S>,
    values?: ComponentValues<S>
  ): void {
    if (!this._alive[entity]) {
      throw new Error(`Entity ${entity} is not alive`);
    }
    const had = component.has(entity);
    component.insert(entity, values);
    if (!had) {
      this.changed(entity, component);
      for (const listener of this._added[component.id]) {
        listener(entity);
      }
    }
  }

  remove(entity: number, component: ComponentStore): void {
    if (!component.has(entity)) {
      return;
    }
    for (const listener of this._removed[component.id]) {
      listener(entity);
    }
    component.delete(entity);
    this.changed(entity, component);
  }

  has(entity: number, component: ComponentStore): boolean {
    return component.has(entity);
  }

  /**
   * The entities that have all the components given, and none of those in
   * not(): one query per set of terms, kept up to date.
   */
  query(...terms: QueryTerm[]): Query {
    const key = terms
      .map((term) => ('not' in term ? `!${term.not.id}` : `${term.id}`))
      .sort()
      .join(',');
    let query = this._queries.get(key);
    if (!query) {
      query = new Query(terms, this._capacity);
      for (const component of [...query.all, ...query.none]) {
        this._queriesOf[component.id].push(query);
      }
      // The entities already there.
      const first = query.all[0];
      const candidates = first ? first.entities : this.aliveEntities();
      for (const entity of candidates) {
        query.update(entity);
      }
      this._queries.set(key, query);
    }
    return query;
  }

  /** Calls `listener` when an entity receives the component. */
  onAdded(component: ComponentStore, listener: ComponentListener): () => void {
    return subscribe(this._added[component.id], listener);
  }

  /** Calls `listener` before an entity loses the component (its values are still there). */
  onRemoved(
    component: ComponentStore,
    listener: ComponentListener
  ): () => void {
    return subscribe(this._removed[component.id], listener);
  }

  private changed(entity: number, component: ComponentStore): void {
    for (const query of this._queriesOf[component.id]) {
      query.update(entity);
    }
  }

  private aliveEntities(): number[] {
    const entities: number[] = [];
    for (let entity = 0; entity < this._next; entity++) {
      if (this._alive[entity]) {
        entities.push(entity);
      }
    }
    return entities;
  }

  private grow(capacity: number): void {
    const generations = new Uint32Array(capacity);
    generations.set(this._generations);
    this._generations = generations;
    const alive = new Uint8Array(capacity);
    alive.set(this._alive);
    this._alive = alive;
    for (const component of this._components) {
      component.grow(capacity);
    }
    for (const query of this._queries.values()) {
      query.grow(capacity);
    }
    this._capacity = capacity;
  }
}

function subscribe<T>(list: T[], item: T): () => void {
  list.push(item);
  return () => {
    const index = list.indexOf(item);
    if (index >= 0) {
      list.splice(index, 1);
    }
  };
}
