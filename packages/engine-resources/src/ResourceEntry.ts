import { computed, signal, type ReadonlySignal } from '@preact/signals-core';
import { ResourceError } from './errors';
import type { ResourceHandle, ResourceStatus } from './ResourceHandle';
import type { ResourceLoader } from './ResourceLoader';
import type { ResourceType } from './types';

// Internal to the package: the shared state behind the handles.

export type Priority = 'high' | 'normal' | 'low';
export type EntryKind = 'loaded' | 'defined' | 'provided';

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => undefined); // never an "unhandled rejection" for the entry itself
  return { promise, resolve, reject };
}

export interface Waiter {
  resolve(): void;
  reject(error: unknown): void;
}

/** One execution of a loader. An entry has at most one in flight. */
export interface Run {
  readonly entry: ResourceEntry<any>;
  readonly kind: 'load' | 'reload';
  readonly controller: AbortController;
  /** A reload that must not use `loader.update` (the backend changed). */
  readonly replace: boolean;
  priority: Priority;
  /** Started even when the concurrency limit is reached: someone waits for it. */
  forced: boolean;
  started: boolean;
  counted: boolean;
  aborted: boolean;
  deps: HandleImpl<any>[];
  provided: HandleImpl<any>[];
  services: Set<symbol>;
  waiters: Waiter[];
}

/** The result of a reload, waiting for `store.update()` to be applied. */
export interface Staged {
  readonly entry: ResourceEntry<any>;
  readonly loader: ResourceLoader<any, any>;
  readonly value: unknown;
  readonly deps: HandleImpl<any>[];
  readonly provided: HandleImpl<any>[];
  readonly services: Set<symbol>;
  readonly replace: boolean;
}

export interface HandleHost {
  releaseHandle(handle: HandleImpl<any>): void;
}

export class ResourceEntry<T> {
  readonly status = signal<ResourceStatus>('pending');
  readonly error = signal<ResourceError | undefined>(undefined);
  readonly version = signal(0);
  readonly selfProgress = signal<{ loaded: number; total?: number }>({ loaded: 0 });
  /** The dependencies being loaded (or loaded), for the aggregated progress. */
  readonly depHandles = signal<readonly HandleImpl<any>[]>([]);
  readonly totalBytes: ReadonlySignal<number | undefined>;
  readonly progress: ReadonlySignal<number>;
  readonly done = deferred<T>();

  value: T | undefined;
  size = 0;
  refCount = 0;
  loader?: ResourceLoader<T, any>;
  owner?: ResourceEntry<any>;
  deps: HandleImpl<any>[] = [];
  owned: HandleImpl<any>[] = [];
  services = new Set<symbol>();
  run?: Run;
  staged?: Staged;
  dirty: false | 'update' | 'replace' = false;
  disposed = false;
  watched = false;
  unwatch: Array<() => void> = [];
  debounce?: ReturnType<typeof setTimeout>;

  constructor(
    readonly type: ResourceType<T>,
    readonly uri: string,
    readonly key: string,
    readonly options: unknown,
    readonly kind: EntryKind
  ) {
    this.totalBytes = computed(() => {
      const own = this.selfProgress.value.total;
      if (own === undefined) return undefined;
      let total = own;
      for (const dep of this.depHandles.value) {
        const t = dep.entry.totalBytes.value;
        if (t === undefined) return undefined;
        total += t;
      }
      return total;
    });

    // In bytes when every part knows its total, in equal shares otherwise.
    this.progress = computed(() => {
      if (this.status.value === 'ready') return 1;
      const own = this.selfProgress.value;
      const parts: Array<{ fraction: number; weight?: number }> = [
        {
          fraction: own.total ? Math.min(1, own.loaded / own.total) : 0,
          weight: own.total,
        },
      ];
      for (const dep of this.depHandles.value) {
        parts.push({ fraction: dep.entry.progress.value, weight: dep.entry.totalBytes.value });
      }
      const weighted = parts.every((p) => p.weight !== undefined);
      const sum = weighted ? parts.reduce((s, p) => s + p.weight!, 0) : 0;
      if (weighted && sum > 0) {
        return parts.reduce((s, p) => s + p.fraction * (p.weight! / sum), 0);
      }
      return parts.reduce((s, p) => s + p.fraction, 0) / parts.length;
    });
  }
}

export class HandleImpl<T> implements ResourceHandle<T> {
  readonly state = { released: false };
  private readyPromise?: Promise<T>;
  private releaseListeners: Array<() => void> = [];

  constructor(
    readonly entry: ResourceEntry<T>,
    private readonly host: HandleHost
  ) {}

  get type() {
    return this.entry.type;
  }
  get uri() {
    return this.entry.uri;
  }
  get status() {
    return this.entry.status;
  }
  get progress() {
    return this.entry.progress;
  }
  get error() {
    return this.entry.error;
  }
  get version() {
    return this.entry.version;
  }
  get value() {
    return this.entry.value;
  }
  get dependencies(): readonly ResourceHandle<unknown>[] {
    return this.entry.deps;
  }

  get ready(): Promise<T> {
    this.readyPromise ??= new Promise<T>((resolve, reject) => {
      const aborted = () => new ResourceError('aborted', this.entry.uri);
      // Already loaded: the current value, which a reload may have changed
      // since the first load.
      if (this.entry.status.peek() === 'ready' && this.entry.value !== undefined) {
        resolve(this.entry.value);
        return;
      }
      this.entry.done.promise.then(resolve, reject);
      if (this.state.released) {
        if (this.entry.status.peek() !== 'ready') reject(aborted());
      } else {
        // Released before the load ended: this handle no longer waits.
        this.releaseListeners.push(() => reject(aborted()));
      }
    });
    return this.readyPromise;
  }

  require(): T {
    const status = this.entry.status.peek();
    if (status === 'ready' && this.entry.value !== undefined) return this.entry.value;
    throw (
      (status === 'failed' ? this.entry.error.peek() : undefined) ??
      new Error(`Resource ${this.entry.uri} is not ready (${status})`)
    );
  }

  release(): void {
    if (this.state.released) return;
    this.state.released = true;
    this.host.releaseHandle(this);
  }

  /** Called by the store once released. */
  notifyReleased(): void {
    const listeners = this.releaseListeners;
    this.releaseListeners = [];
    for (const l of listeners) l();
  }

  [Symbol.dispose](): void {
    this.release();
  }
}
