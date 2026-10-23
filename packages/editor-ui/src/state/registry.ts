import type { IDisposable } from './services';

/** A change of a registry: an item added, or removed. */
export interface RegistryChange<T> {
  readonly kind: 'add' | 'remove';
  readonly item: T;
}

/**
 * Items contributed by id (the tools, the modes; the views and the
 * commands at step 12 of P18). An id is registered once; the registration
 * gives back its removal.
 */
export class Registry<T extends { readonly id: string }> {
  readonly #items = new Map<string, T>();
  readonly #listeners = new Set<(change: RegistryChange<T>) => void>();
  // Changed at each change, for useSyncExternalStore.
  #all: readonly T[] = [];

  constructor(readonly kind: string) {}

  register(item: T): IDisposable {
    if (this.#items.has(item.id)) {
      throw new Error(`The ${this.kind} ${item.id} is already registered`);
    }
    this.#items.set(item.id, item);
    this.#changed({ kind: 'add', item });
    return {
      dispose: () => {
        if (this.#items.get(item.id) !== item) return;
        this.#items.delete(item.id);
        this.#changed({ kind: 'remove', item });
      },
    };
  }

  get(id: string): T | undefined {
    return this.#items.get(id);
  }

  /** The items, in their order of registration; the same array until a change. */
  all(): readonly T[] {
    return this.#all;
  }

  /** Listens to the changes; returns the unsubscription. */
  subscribe(listener: (change: RegistryChange<T>) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed(change: RegistryChange<T>): void {
    this.#all = [...this.#items.values()];
    for (const listener of [...this.#listeners]) listener(change);
  }
}
