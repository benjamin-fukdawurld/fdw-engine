import { ResourceType } from './types';
import { LoadContext } from './LoadContext';

export interface LoadOptions<O> {
  readonly options?: O;
  readonly priority?: 'high' | 'normal' | 'low';
  readonly signal?: AbortSignal; // an external cancellation
}

export interface ResourceLoader<T, O = void> {
  readonly type: ResourceType<T>;
  readonly extensions?: readonly string[]; // ['glb', 'gltf']
  readonly mimeTypes?: readonly string[];
  // Recognizes a format from its first bytes, when the extension lies.
  sniff?(head: Uint8Array): boolean;
  // Part of the cache key: two option values with the same key share an entry.
  cacheKey?(options: O): string;
  load(context: LoadContext<O>): Promise<T>;
  // Updates `current` from the freshly loaded `next` without replacing it
  // (a texture rewritten, a mesh whose vertices change). Returns false when
  // it cannot: the entry then switches to `next`.
  update?(current: T, next: T): boolean;
  // Frees what the value holds: GPU objects, workers…
  dispose?(value: T): void;
  // Memory held, for the budget of the cache.
  sizeOf?(value: T): number;
}
