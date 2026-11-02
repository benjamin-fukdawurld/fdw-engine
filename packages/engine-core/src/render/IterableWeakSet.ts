/**
 * A set of objects that does not keep them alive, and can be iterated (a
 * WeakSet cannot): the renderer frees with it, when destroyed, the GPU
 * resources of the meshes and materials it drew, which stay free to be
 * collected before.
 */
export class IterableWeakSet<T extends object> {
  private readonly _refs = new WeakMap<T, WeakRef<T>>();
  private readonly _all = new Set<WeakRef<T>>();
  // Forgets the entries of the objects collected.
  private readonly _registry = new FinalizationRegistry<WeakRef<T>>((ref) =>
    this._all.delete(ref),
  );

  add(value: T): void {
    if (this._refs.has(value)) {
      return;
    }
    const ref = new WeakRef(value);
    this._refs.set(value, ref);
    this._all.add(ref);
    this._registry.register(value, ref, ref);
  }

  has(value: T): boolean {
    return this._refs.has(value);
  }

  delete(value: T): void {
    const ref = this._refs.get(value);
    if (ref) {
      this._refs.delete(value);
      this._all.delete(ref);
      this._registry.unregister(ref);
    }
  }

  /** The objects still alive. */
  *[Symbol.iterator](): IterableIterator<T> {
    for (const ref of [...this._all]) {
      const value = ref.deref();
      if (value) {
        yield value;
      }
    }
  }

  clear(): void {
    for (const value of this) {
      this.delete(value);
    }
    this._all.clear();
  }
}
