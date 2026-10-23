/** What a registration gives back: undoes it. */
export interface IDisposable {
  dispose(): void;
}

/** The identifier of a service: `get` returns a T, without a cast. */
export interface ServiceId<T> {
  readonly name: string;
  // Never set: carries the type of the service.
  readonly type?: T;
}

export function serviceId<T>(name: string): ServiceId<T> {
  return { name };
}

/** The services a scope sees. */
export interface ServiceAccessor {
  get<T>(id: ServiceId<T>): T;
  /** The service; undefined if none is registered or visible. */
  find<T>(id: ServiceId<T>): T | undefined;
  has(id: ServiceId<unknown>): boolean;
}

export interface ServiceOptions<T> {
  /** Created at its first use (the default), or at once. */
  readonly lazy?: boolean;
  /**
   * Called on the service created when it is unregistered; by default, its
   * own `dispose()` if it has one.
   */
  readonly dispose?: (service: T) => void;
}

interface Entry {
  readonly factory: (services: ServiceAccessor) => unknown;
  readonly dispose?: (service: never) => void;
  created: boolean;
  creating: boolean;
  service?: unknown;
}

function disposeService(entry: Entry): void {
  if (!entry.created) return;
  const service = entry.service as { dispose?: unknown } | undefined;
  if (entry.dispose) (entry.dispose as (service: unknown) => void)(service);
  else if (typeof service?.dispose === 'function') service.dispose();
}

/**
 * The services of the editor (design/editor-state.md §5): what is not
 * serializable (the host, the connection to the engine, the services of the
 * plugins), reachable out of React. A scope, made for a plugin, sees its own
 * services and those of its parent it is given; disposed, it disposes what
 * was registered in it.
 */
export class ServiceRegistry implements ServiceAccessor, IDisposable {
  readonly name: string;
  readonly #parent?: ServiceRegistry;
  // The services of the parent this scope sees; all if undefined.
  readonly #visible?: ReadonlySet<string>;
  readonly #entries = new Map<string, Entry>();
  readonly #scopes = new Set<ServiceRegistry>();
  #disposed = false;

  constructor(
    name = 'root',
    parent?: ServiceRegistry,
    visible?: readonly ServiceId<unknown>[],
  ) {
    this.name = name;
    this.#parent = parent;
    if (visible) this.#visible = new Set(visible.map((id) => id.name));
  }

  /**
   * Registers the service of the id in this scope, made by the factory with
   * the services of the scope. An id is registered once per scope; a scope
   * may hide one of its parent.
   */
  register<T>(
    id: ServiceId<T>,
    factory: (services: ServiceAccessor) => T,
    options: ServiceOptions<T> = {},
  ): IDisposable {
    this.#check();
    if (this.#entries.has(id.name)) {
      throw new Error(
        `The service ${id.name} is already registered in ${this.name}`,
      );
    }
    const entry: Entry = {
      factory,
      dispose: options.dispose,
      created: false,
      creating: false,
    };
    this.#entries.set(id.name, entry);
    if (options.lazy === false) this.get(id);
    return {
      dispose: () => {
        if (this.#entries.get(id.name) !== entry) return;
        this.#entries.delete(id.name);
        disposeService(entry);
      },
    };
  }

  get<T>(id: ServiceId<T>): T {
    const found = this.#find(id.name);
    if (!found) throw new Error(`No service ${id.name} in ${this.name}`);
    const [entry, owner] = found;
    if (!entry.created) {
      if (entry.creating) {
        throw new Error(`The service ${id.name} needs itself to be created`);
      }
      entry.creating = true;
      try {
        // With the services of its scope, not those of the asking one.
        entry.service = entry.factory(owner);
        entry.created = true;
      } finally {
        entry.creating = false;
      }
    }
    return entry.service as T;
  }

  find<T>(id: ServiceId<T>): T | undefined {
    return this.has(id) ? this.get(id) : undefined;
  }

  has(id: ServiceId<unknown>): boolean {
    return this.#find(id.name) !== undefined;
  }

  /**
   * A scope of this registry: its services, and those of this one; only
   * those listed if `visible` is given.
   */
  createScope(
    name: string,
    visible?: readonly ServiceId<unknown>[],
  ): ServiceRegistry {
    this.#check();
    const scope = new ServiceRegistry(name, this, visible);
    this.#scopes.add(scope);
    return scope;
  }

  /** Disposes the scopes, then the services, the last registered first. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const scope of [...this.#scopes].reverse()) scope.dispose();
    for (const entry of [...this.#entries.values()].reverse()) {
      disposeService(entry);
    }
    this.#entries.clear();
    if (this.#parent) this.#parent.#scopes.delete(this);
  }

  #find(name: string): [Entry, ServiceRegistry] | undefined {
    if (this.#disposed) return undefined;
    const entry = this.#entries.get(name);
    if (entry) return [entry, this];
    if (this.#visible && !this.#visible.has(name)) return undefined;
    return this.#parent ? this.#parent.#find(name) : undefined;
  }

  #check(): void {
    if (this.#disposed) throw new Error(`The scope ${this.name} is disposed`);
  }
}
