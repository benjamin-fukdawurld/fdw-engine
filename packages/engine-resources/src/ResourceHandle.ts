import type { ReadonlySignal } from '@preact/signals-core';
import type { ResourceError } from './errors';
import type { ResourceType, ResourceUri } from './types';

export type ResourceStatus =
  | 'pending'
  | 'loading'
  | 'ready'
  | 'failed'
  | 'cancelled';

export interface ResourceHandle<T> {
  readonly type: ResourceType<T>;
  /** The canonical URI: `scheme:path#fragment`, with the default scheme made explicit. */
  readonly uri: ResourceUri;
  readonly status: ReadonlySignal<ResourceStatus>;
  readonly progress: ReadonlySignal<number>; // 0 to 1
  /** The last failure. A failed reload keeps the previous value and sets this. */
  readonly error: ReadonlySignal<ResourceError | undefined>;
  // Incremented each time the value changes (loaded, reloaded).
  readonly version: ReadonlySignal<number>;
  // The current value: the previous one stays while a reload is under way.
  readonly value: T | undefined;
  readonly ready: Promise<T>; // first load; rejects on failure or cancel
  require(): T; // throws when not ready
  readonly dependencies: readonly ResourceHandle<unknown>[];

  // Idempotent. The last handle of an entry that is loading cancels the load.
  release(): void;
  [Symbol.dispose](): void; // `using handle = store.load(…)`
}
