import { ResourceType, ServiceKey, ResourceUri, LoadGroup } from './types';
import { LoadOptions, ResourceLoader } from './ResourceLoader';
import { ResourceSource } from './ResourceSource';
import { ResourceHandle } from './ResourceHandle';

export interface ResourceScope {
  load: ResourceStore['load']; // handles owned by the scope
  adopt<T>(handle: ResourceHandle<T>): ResourceHandle<T>;
  dispose(): void; // releases every handle
}

export abstract class ResourceStore {
  readonly concurrency: number; // loads under way at once
  readonly budget: number; // current memory usage for unused entries

  private resourceLoader: Map<
    ResourceType<unknown>,
    ResourceLoader<unknown, unknown>
  >;
  private source: Map<
    string,
    { source: ResourceSource; priority: number; default: boolean }[]
  >;
  private services: Map<symbol, unknown>;

  constructor(options?: {
    concurrency?: number; // loads under way at once, 8 by default
    budget?: number; // bytes kept for unused entries, 256 MiB by default
  }) {
    this.concurrency = options?.concurrency ?? 8;
    this.budget = options?.budget ?? 256 * 1024 * 1024;

    this.resourceLoader = new Map<
      ResourceType<unknown>,
      ResourceLoader<unknown, unknown>
    >();
    this.source = new Map<
      string,
      { source: ResourceSource; priority: number; default: boolean }[]
    >();
    this.services = new Map<symbol, unknown>();
  }

  registerLoader<T, O>(loader: ResourceLoader<T, O>): this {
    this.resourceLoader.set(loader.type, loader);
    return this;
  }

  // Several sources under one scheme are tried by priority (patch over archive).
  mount(
    scheme: string,
    source: ResourceSource,
    options?: { priority?: number; default?: boolean }
  ): this {
    const entry = {
      source,
      priority: options?.priority ?? 0,
      default: options?.default ?? false,
    };
    let entries = this.source.get(scheme);
    if (!entries) {
      entries = [];
      this.source.set(scheme, entries);
    }
    entries.push(entry);
    entries.sort((a, b) => {
      switch (true) {
        case a.default && !b.default:
          return -1;
        case !a.default && b.default:
          return 1;
        default:
          return b.priority - a.priority;
      }
    });

    return this;
  }

  provideService<S>(key: ServiceKey<S>, value: S): this {
    this.services.set(key.id, value);
    return this;
  }

  abstract load<T, O = void>(
    type: ResourceType<T>,
    uri: ResourceUri,
    options?: LoadOptions<O>
  ): ResourceHandle<T>;

  // A handle to an entry already known, without starting a load.
  abstract peek<T>(
    type: ResourceType<T>,
    uri: ResourceUri
  ): ResourceHandle<T> | undefined;

  // A resource made in memory (a generated mesh) with the same handle semantics.
  abstract define<T>(
    type: ResourceType<T>,
    uri: ResourceUri,
    value: T
  ): ResourceHandle<T>;

  abstract scope(name?: string): ResourceScope;
  abstract group(handles: Iterable<ResourceHandle<unknown>>): LoadGroup;

  abstract reload(uri: ResourceUri): Promise<void>;
  abstract watch(enabled: boolean): void; // the hot reload, §6.7

  // Frees unused entries down to the budget; all of them with 0.
  abstract trim(budget?: number): void;
  // Called once per frame: applies the pending changes, within a time budget.
  abstract update(budgetMs?: number): void;
  abstract dispose(): void;
}
