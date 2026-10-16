import { batch, computed } from '@preact/signals-core';
import { isAbortError, ResourceError } from './errors';
import type { LoadContext } from './LoadContext';
import type { ResourceHandle } from './ResourceHandle';
import type { LoadOptions, ResourceLoader } from './ResourceLoader';
import type { ResourceSource } from './ResourceSource';
import {
  deferred,
  HandleImpl,
  ResourceEntry,
  type HandleHost,
  type Priority,
  type Run,
  type Staged,
} from './ResourceEntry';
import type { LoadGroup, ResourceBytes, ResourceType, ResourceUri, ServiceKey } from './types';
import { extname, formatUri, normalizePath, parseUri, resolvePath } from './uri';

export interface ResourceScope {
  readonly name?: string;
  load: ResourceStore['load']; // handles owned by the scope
  adopt<T>(handle: ResourceHandle<T>): ResourceHandle<T>;
  dispose(): void; // releases every handle
}

export interface ResourceStoreOptions {
  /** Loads under way at once, 8 by default. Dependencies do not count. */
  concurrency?: number;
  /** Bytes kept for unused entries, 256 MiB by default. */
  budget?: number;
  /** Quiet time after a source change before reloading, 50 ms by default. */
  debounceMs?: number;
  /** Receives the warnings (leaked handles, failing `dispose`). */
  warn?: (message: string, cause?: unknown) => void;
}

interface MountedSource {
  readonly source: ResourceSource;
  readonly priority: number;
}

interface Retired {
  readonly loader: ResourceLoader<any, any> | undefined;
  readonly value: unknown;
  readonly waiting: Set<ResourceEntry<any>>;
}

const PRIORITIES: readonly Priority[] = ['high', 'normal', 'low'];
const RANK: Record<Priority, number> = { high: 0, normal: 1, low: 2 };
const decoder = new TextDecoder('utf-8');
const noop = () => undefined;

export class ResourceStore implements HandleHost {
  readonly concurrency: number; // loads under way at once
  readonly budget: number; // bytes kept for unused entries

  private readonly debounceMs: number;
  private readonly warn: (message: string, cause?: unknown) => void;

  private readonly loaders = new Map<ResourceType<any>, ResourceLoader<any, any>[]>();
  private readonly sources = new Map<string, MountedSource[]>();
  private defaultScheme?: string;
  private readonly services = new Map<symbol, unknown>();

  private readonly index = new Map<ResourceType<any>, Map<string, ResourceEntry<any>>>();
  /** Entries without handles, least recently used first. */
  private readonly idle = new Set<ResourceEntry<any>>();
  private readonly queue: Record<Priority, Run[]> = { high: [], normal: [], low: [] };
  private running = 0;
  private pumpScheduled = false;
  private readonly staged: Staged[] = [];
  private readonly retired: Retired[] = [];
  private watching = false;
  private trimming = false;
  private disposed = false;

  // A safety net for forgotten handles, never the mechanism.
  private readonly leaks = new FinalizationRegistry<{
    entry: ResourceEntry<any>;
    state: { released: boolean };
    uri: string;
  }>((held) => {
    if (held.state.released) return;
    held.state.released = true;
    this.warn(`Resource handle for ${held.uri} was garbage-collected without release()`);
    this.unref(held.entry);
  });

  constructor(options?: ResourceStoreOptions) {
    this.concurrency = Math.max(1, options?.concurrency ?? 8);
    this.budget = options?.budget ?? 256 * 1024 * 1024;
    this.debounceMs = options?.debounceMs ?? 50;
    this.warn = options?.warn ?? ((m, cause) => console.warn(`[resources] ${m}`, cause ?? ''));
  }

  // ------------------------------------------------------------------
  // Registration
  // ------------------------------------------------------------------

  /**
   * Several loaders may serve one type (glTF and OBJ both make a model): the
   * one chosen depends on the extension, then on `sniff`. A type with a
   * single loader always uses it. Among equals the last registered wins.
   */
  registerLoader<T, O>(loader: ResourceLoader<T, O>): this {
    let list = this.loaders.get(loader.type);
    if (!list) this.loaders.set(loader.type, (list = []));
    if (!list.includes(loader)) list.push(loader);
    return this;
  }

  // Several sources under one scheme are tried by priority (patch over archive).
  mount(
    scheme: string,
    source: ResourceSource,
    options?: { priority?: number; default?: boolean }
  ): this {
    let list = this.sources.get(scheme);
    if (!list) this.sources.set(scheme, (list = []));
    list.push({ source, priority: options?.priority ?? 0 });
    list.sort((a, b) => b.priority - a.priority); // stable: first mounted wins ties
    if (options?.default) this.defaultScheme = scheme;
    return this;
  }

  /**
   * Replacing a service re-realizes, from their data, the entries that used
   * the previous one (a new render backend): their loaders are asked to
   * rebuild, never to update in place.
   */
  provideService<S>(key: ServiceKey<S>, value: S): this {
    const had = this.services.has(key.id);
    const previous = this.services.get(key.id);
    this.services.set(key.id, value);
    if (had && previous !== value) {
      for (const entry of this.allEntries()) {
        if (entry.kind !== 'loaded' || entry.disposed) continue;
        if (entry.services.has(key.id) || entry.run?.services.has(key.id)) {
          void this.reloadEntry(entry, true).catch(noop);
        }
      }
    }
    return this;
  }

  // ------------------------------------------------------------------
  // Loading
  // ------------------------------------------------------------------

  load<T, O = void>(
    type: ResourceType<T>,
    uri: ResourceUri,
    options?: LoadOptions<O>
  ): ResourceHandle<T> {
    this.assertAlive();
    const handle = this.acquire<T>(type, uri, options?.options, options?.priority ?? 'normal', false);
    const signal = options?.signal;
    if (signal) {
      if (signal.aborted) handle.release();
      else signal.addEventListener('abort', () => handle.release(), { once: true });
    }
    return handle;
  }

  // A handle to an entry already known, without starting a load. Like any
  // handle it must be released.
  peek<T>(type: ResourceType<T>, uri: ResourceUri): ResourceHandle<T> | undefined {
    const canon = this.canonical(uri);
    const entry = this.index.get(type)?.get(this.keyOf(type, canon.text, undefined));
    if (!entry || !this.isUsable(entry)) return undefined;
    return this.newHandle(entry);
  }

  // A resource made in memory (a generated mesh) with the same handle
  // semantics. It cannot be rebuilt, so it is disposed with its last handle.
  define<T>(type: ResourceType<T>, uri: ResourceUri, value: T): ResourceHandle<T> {
    this.assertAlive();
    const canon = this.canonical(uri);
    const key = this.keyOf(type, canon.text, undefined);
    const map = this.entriesOf(type);
    const existing = map.get(key);
    if (existing && !existing.disposed) {
      throw new Error(`Resource already defined: ${canon.text}`);
    }
    const entry = new ResourceEntry<T>(type, canon.text, key, undefined, 'defined');
    entry.value = value;
    entry.version.value = 1;
    entry.status.value = 'ready';
    entry.done.resolve(value);
    map.set(key, entry);
    return this.newHandle(entry);
  }

  scope(name?: string): ResourceScope {
    const handles = new Set<ResourceHandle<unknown>>();
    let disposed = false;
    const assertOpen = () => {
      if (disposed) throw new Error(`Scope${name ? ` "${name}"` : ''} is disposed`);
    };
    return {
      name,
      load: (type, uri, options) => {
        assertOpen();
        const handle = this.load(type, uri, options);
        handles.add(handle);
        return handle;
      },
      adopt: (handle) => {
        assertOpen();
        handles.add(handle);
        return handle;
      },
      dispose: () => {
        disposed = true;
        for (const handle of handles) handle.release();
        handles.clear();
      },
    };
  }

  group(handles: Iterable<ResourceHandle<unknown>>): LoadGroup {
    const list = [...handles];
    let ready: Promise<void> | undefined;
    return {
      progress: computed(() =>
        list.length === 0 ? 1 : list.reduce((s, h) => s + h.progress.value, 0) / list.length
      ),
      pending: computed(
        () =>
          list.filter((h) => {
            const s = h.status.value;
            return s === 'pending' || s === 'loading';
          }).length
      ),
      get ready() {
        // Created on demand, so that a group nobody awaits never reports an
        // unhandled rejection.
        return (ready ??= Promise.all(list.map((h) => h.ready)).then(noop));
      },
    };
  }

  // ------------------------------------------------------------------
  // Reload, cache, frame update
  // ------------------------------------------------------------------

  /**
   * Reloads every entry of the URI. Resolves once the new value is loaded and
   * staged; `update()` makes it visible, between two frames. Rejects when the
   * reload fails (the previous value stays).
   */
  async reload(uri: ResourceUri): Promise<void> {
    const text = this.canonical(uri).text;
    const targets = this.allEntries().filter((e) => e.uri === text && !e.disposed);
    await Promise.all(targets.map((e) => this.reloadEntry(e)));
  }

  /** The hot reload: sources watch the paths of the loaded entries. */
  watch(enabled: boolean): void {
    if (this.watching === enabled) return;
    this.watching = enabled;
    for (const entry of this.allEntries()) {
      if (enabled) {
        if (entry.status.peek() === 'ready') this.watchEntry(entry);
      } else {
        this.unwatchEntry(entry);
      }
    }
  }

  // Frees unused entries down to the budget; all of them with 0.
  trim(budget: number = this.budget): void {
    if (this.trimming) return;
    this.trimming = true;
    try {
      while (this.idle.size > 0) {
        let total = 0;
        for (const e of this.idle) total += e.size;
        if (budget !== 0 && total <= budget) break;
        // Destroying an entry may make its dependencies idle: the loop goes on.
        this.destroyEntry(this.idle.values().next().value!);
      }
    } finally {
      this.trimming = false;
    }
  }

  // Called once per frame: applies the pending changes, within a time budget
  // (at least one per call).
  update(budgetMs = 2): void {
    const start = now();
    while (this.staged.length > 0) {
      this.applyStaged(this.staged.shift()!);
      if (now() - start >= budgetMs) break;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.allEntries()) this.destroyEntry(entry);
    for (const r of this.retired.splice(0)) this.disposeWith(r.loader, r.value);
    this.staged.length = 0;
    this.idle.clear();
    this.index.clear();
    for (const p of PRIORITIES) this.queue[p].length = 0;
  }

  // ------------------------------------------------------------------
  // Handles and lifetimes
  // ------------------------------------------------------------------

  releaseHandle(handle: HandleImpl<any>): void {
    this.leaks.unregister(handle.state);
    handle.notifyReleased();
    this.unref(handle.entry);
  }

  private newHandle<T>(entry: ResourceEntry<T>): HandleImpl<T> {
    this.idle.delete(entry);
    entry.refCount++;
    const handle = new HandleImpl(entry, this);
    this.leaks.register(handle, { entry, state: handle.state, uri: entry.uri }, handle.state);
    return handle;
  }

  private unref(entry: ResourceEntry<any>): void {
    if (entry.disposed || --entry.refCount > 0) return;
    if (entry.kind !== 'loaded') {
      this.destroyEntry(entry); // cannot be rebuilt: no cache
      return;
    }
    if (entry.status.peek() === 'ready') {
      // Cached while unused, up to the budget.
      this.idle.delete(entry);
      this.idle.add(entry);
      this.trim();
    } else {
      // Loading: nobody waits for it any more, so the load is cancelled.
      // Failed or cancelled: nothing to keep.
      this.destroyEntry(entry);
    }
  }

  private destroyEntry(entry: ResourceEntry<any>): void {
    if (entry.disposed) return;
    entry.disposed = true;
    this.idle.delete(entry);
    this.unwatchEntry(entry);
    if (entry.run) this.abortRun(entry.run);
    if (entry.staged) {
      this.discardStaged(entry.staged);
      entry.staged = undefined;
    }
    const status = entry.status.peek();
    if (status === 'pending' || status === 'loading') {
      batch(() => {
        entry.status.value = 'cancelled';
      });
      entry.done.reject(new ResourceError('aborted', entry.uri));
    }
    const map = this.index.get(entry.type);
    if (map?.get(entry.key) === entry) map.delete(entry.key);

    if (entry.value !== undefined) {
      this.disposeValue(entry.type, entry.loader, entry.value);
      entry.value = undefined;
    }
    // The value first: it may still point at its dependencies.
    const deps = entry.deps;
    const owned = entry.owned;
    entry.deps = [];
    entry.owned = [];
    for (const h of deps) h.release();
    for (const h of owned) h.release();
    this.settle(entry);
  }

  private isUsable(entry: ResourceEntry<any>): boolean {
    const s = entry.status.peek();
    return !entry.disposed && s !== 'failed' && s !== 'cancelled';
  }

  // ------------------------------------------------------------------
  // Identity
  // ------------------------------------------------------------------

  private canonical(uri: string): { scheme?: string; path: string; fragment?: string; text: string } {
    const p = parseUri(uri, (s) => this.sources.has(s));
    const scheme = p.scheme ?? this.defaultScheme;
    // A data URI is its payload: collapsing its slashes would corrupt it.
    const path = scheme === 'data' ? p.path : normalizePath(p.path);
    return { scheme, path, fragment: p.fragment, text: formatUri({ scheme, path, fragment: p.fragment }) };
  }

  private keyOf(type: ResourceType<any>, canonicalUri: string, options: unknown): string {
    const custom = this.loaders.get(type)?.find((l) => l.cacheKey);
    let suffix = '';
    if (custom?.cacheKey) suffix = custom.cacheKey(options);
    else if (options !== undefined) {
      try {
        suffix = JSON.stringify(options) ?? '';
      } catch {
        suffix = '';
      }
    }
    return suffix ? `${canonicalUri}\u0000${suffix}` : canonicalUri;
  }

  private entriesOf(type: ResourceType<any>): Map<string, ResourceEntry<any>> {
    let map = this.index.get(type);
    if (!map) this.index.set(type, (map = new Map()));
    return map;
  }

  private allEntries(): ResourceEntry<any>[] {
    const all: ResourceEntry<any>[] = [];
    for (const map of this.index.values()) all.push(...map.values());
    return all;
  }

  private parentsOf(entry: ResourceEntry<any>): ResourceEntry<any>[] {
    return this.allEntries().filter(
      (e) => e !== entry && !e.disposed && e.deps.some((h) => h.entry === entry)
    );
  }

  private resolveUri(baseUri: string, relative: string): string {
    const isScheme = (s: string) => this.sources.has(s);
    const rel = parseUri(relative, isScheme);
    if (rel.scheme !== undefined) return this.canonical(relative).text;
    const base = parseUri(baseUri, isScheme);
    const path = relative.startsWith('#') ? base.path : resolvePath(base.path, rel.path);
    return formatUri({ scheme: base.scheme, path, fragment: rel.fragment });
  }

  // ------------------------------------------------------------------
  // The queue
  // ------------------------------------------------------------------

  private acquire<T>(
    type: ResourceType<T>,
    uri: string,
    options: unknown,
    priority: Priority,
    forced: boolean
  ): HandleImpl<T> {
    const canon = this.canonical(uri);
    const key = this.keyOf(type, canon.text, options);
    const map = this.entriesOf(type);
    let entry = map.get(key);
    // A failed load is retried by the next request; the old entry stays with
    // its own handles.
    if (entry && !this.isUsable(entry)) entry = undefined;

    if (!entry) {
      entry = new ResourceEntry<T>(type, canon.text, key, options, 'loaded');
      map.set(key, entry);
      this.enqueue(entry, 'load', priority, forced, false);
    } else if (entry.status.peek() === 'pending' && entry.run && !entry.run.started) {
      this.promote(entry.run, priority, forced);
    }
    return this.newHandle(entry);
  }

  private enqueue(
    entry: ResourceEntry<any>,
    kind: 'load' | 'reload',
    priority: Priority,
    forced: boolean,
    replace: boolean
  ): Run {
    const run: Run = {
      entry,
      kind,
      controller: new AbortController(),
      replace,
      priority,
      forced,
      started: false,
      counted: false,
      aborted: false,
      deps: [],
      provided: [],
      services: new Set(),
      waiters: [],
    };
    entry.run = run;
    this.queue[priority].push(run);
    this.schedulePump();
    return run;
  }

  private promote(run: Run, priority: Priority, forced: boolean): void {
    if (RANK[priority] < RANK[run.priority]) {
      const from = this.queue[run.priority];
      const i = from.indexOf(run);
      if (i >= 0) {
        from.splice(i, 1);
        this.queue[priority].push(run);
      }
      run.priority = priority;
    }
    if (forced && !run.forced) {
      run.forced = true;
      this.schedulePump();
    }
  }

  private schedulePump(): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    queueMicrotask(() => this.pump());
  }

  private pump(): void {
    this.pumpScheduled = false;
    if (this.disposed) return;
    // A loader waiting for a dependency holds a slot: dependencies must not
    // wait for one, or the store would deadlock at its concurrency limit.
    for (const p of PRIORITIES) {
      const q = this.queue[p];
      for (let i = 0; i < q.length; ) {
        if (q[i].forced) this.startRun(q.splice(i, 1)[0], false);
        else i++;
      }
    }
    while (this.running < this.concurrency) {
      const priority = PRIORITIES.find((p) => this.queue[p].length > 0);
      if (!priority) break;
      const run = this.queue[priority].shift()!;
      this.startRun(run, true);
    }
  }

  private startRun(run: Run, counted: boolean): void {
    run.started = true;
    run.counted = counted;
    if (counted) this.running++;
    if (run.kind === 'load') run.entry.status.value = 'loading';
    void this.execute(run);
  }

  private abortRun(run: Run): void {
    if (run.aborted) return;
    run.aborted = true;
    run.controller.abort();
    if (!run.started) {
      const q = this.queue[run.priority];
      const i = q.indexOf(run);
      if (i >= 0) q.splice(i, 1);
    }
    this.releaseRunResources(run);
    for (const w of run.waiters.splice(0)) w.reject(new ResourceError('aborted', run.entry.uri));
    if (run.entry.run === run) run.entry.run = undefined;
  }

  private releaseRunResources(run: Run): void {
    const deps = run.deps.splice(0);
    const provided = run.provided.splice(0);
    for (const h of deps) h.release();
    for (const h of provided) h.release();
  }

  // ------------------------------------------------------------------
  // Running a loader
  // ------------------------------------------------------------------

  private async execute(run: Run): Promise<void> {
    const entry = run.entry;
    let loader: ResourceLoader<any, any> | undefined;
    let value: unknown;
    let produced = false;
    try {
      const ctx = this.createContext(run);
      loader = await this.selectLoader(entry, ctx);
      value = await loader.load(ctx);
      produced = true;
      if (run.aborted || entry.disposed) {
        this.disposeValue(entry.type, loader, value);
        return;
      }
      this.finishRun(run, loader, value);
    } catch (e) {
      if (produced && value !== undefined && (run.aborted || entry.disposed)) {
        this.disposeValue(entry.type, loader, value);
      }
      if (run.aborted || entry.disposed) return; // cancelled: nothing to report
      this.failRun(run, this.wrapError(e, entry));
    } finally {
      if (run.counted) {
        this.running--;
        this.schedulePump();
      }
    }
  }

  private finishRun(run: Run, loader: ResourceLoader<any, any>, value: unknown): void {
    const entry = run.entry;
    if (run.kind === 'load') {
      this.indexProvided(run.provided);
      batch(() => {
        entry.loader = loader;
        entry.value = value;
        entry.size = this.sizeOf(loader, value);
        entry.deps = run.deps;
        entry.depHandles.value = run.deps;
        entry.owned = run.provided;
        entry.services = run.services;
        entry.run = undefined;
        entry.error.value = undefined;
        entry.version.value = entry.version.peek() + 1;
        entry.status.value = 'ready';
      });
      entry.done.resolve(value);
      if (this.watching) this.watchEntry(entry);
      if (entry.dirty) {
        const replace = entry.dirty === 'replace';
        entry.dirty = false;
        void this.reloadEntry(entry, replace).catch(noop);
      }
      return;
    }

    // A reload: the old value stays in use until `update()` swaps it.
    if (entry.staged) this.discardStaged(entry.staged);
    const staged: Staged = {
      entry,
      loader,
      value,
      deps: run.deps,
      provided: run.provided,
      services: run.services,
      replace: run.replace,
    };
    entry.staged = staged;
    entry.run = undefined;
    this.staged.push(staged);
    for (const w of run.waiters.splice(0)) w.resolve();
  }

  private failRun(run: Run, error: ResourceError): void {
    const entry = run.entry;
    this.releaseRunResources(run);
    if (entry.run === run) entry.run = undefined;
    if (run.kind === 'load') {
      batch(() => {
        entry.error.value = error;
        entry.status.value = 'failed';
      });
      entry.done.reject(error);
    } else {
      // The previous value stays, and so does whatever it still points at.
      entry.error.value = error;
      for (const w of run.waiters.splice(0)) w.reject(error);
    }
  }

  private wrapError(e: unknown, entry: ResourceEntry<any>): ResourceError {
    if (e instanceof ResourceError) {
      if (e.uri === entry.uri) return e;
      // A cycle already names everyone in it: it goes up unchanged.
      if (e.cycle && e.path.includes(entry.uri)) return e;
      // Raised by a dependency: keep the chain, `oak.glb → bark.png`.
      return new ResourceError(
        'dependency',
        entry.uri,
        `Dependency failed: ${[entry.uri, ...e.path].join(' → ')}: ${e.message}`,
        { cause: e, path: [entry.uri, ...e.path] }
      );
    }
    const message = e instanceof Error ? e.message : String(e);
    return new ResourceError('decode', entry.uri, `Failed to load ${entry.uri}: ${message}`, {
      cause: e,
    });
  }

  private async selectLoader(
    entry: ResourceEntry<any>,
    ctx: LoadContext<any>
  ): Promise<ResourceLoader<any, any>> {
    const list = this.loaders.get(entry.type) ?? [];
    if (list.length === 0) {
      throw new ResourceError('unsupported', entry.uri, `No loader registered for type "${entry.type.name}"`);
    }
    if (list.length === 1) return list[0];

    const ext = extname(parseUri(entry.uri, (s) => this.sources.has(s)).path);
    const byExtension = [...list].reverse().find((l) => l.extensions?.some((x) => x.toLowerCase() === ext));
    if (byExtension) return byExtension;

    if (list.some((l) => l.sniff)) {
      const head = (await ctx.bytes()).subarray(0, 64);
      const bySniff = [...list].reverse().find((l) => l.sniff?.(head));
      if (bySniff) return bySniff;
    }
    const generic = [...list].reverse().find((l) => !l.extensions?.length && !l.sniff);
    if (generic) return generic;
    throw new ResourceError('unsupported', entry.uri, `No loader of type "${entry.type.name}" recognizes ${entry.uri}`);
  }

  private async readBytes(entry: ResourceEntry<any>, run: Run): Promise<ResourceBytes> {
    const { scheme, path } = parseUri(entry.uri, (s) => this.sources.has(s));
    const layers = scheme !== undefined ? this.sources.get(scheme) : undefined;
    if (!layers) {
      throw new ResourceError('not-found', entry.uri, `No source mounted for ${entry.uri}`);
    }
    for (const layer of layers) {
      try {
        const bytes = await layer.source.read(path, {
          signal: run.controller.signal,
          onProgress: (loaded, total) => {
            if (run.kind === 'load') entry.selfProgress.value = { loaded, total };
          },
        });
        run.controller.signal.throwIfAborted();
        return bytes;
      } catch (e) {
        if (e instanceof ResourceError && e.code === 'not-found') continue; // next layer
        if (isAbortError(e)) throw e;
        throw e instanceof ResourceError
          ? new ResourceError(e.code, entry.uri, e.message, { cause: e.cause })
          : e;
      }
    }
    throw new ResourceError('not-found', entry.uri);
  }

  private createContext(run: Run): LoadContext<any> {
    const entry = run.entry;
    const assertOpen = () => {
      if (run.aborted) throw new ResourceError('aborted', entry.uri);
    };
    let bytes: Promise<ResourceBytes> | undefined;

    const ctx: LoadContext<any> = {
      uri: entry.uri,
      options: entry.options,
      signal: run.controller.signal,
      bytes: () => (bytes ??= this.readBytes(entry, run)),
      text: async () => decoder.decode(await ctx.bytes()),
      resolve: (relative) => this.resolveUri(entry.uri, relative),

      use: <U, P>(type: ResourceType<U>, uri: ResourceUri, options?: P) => {
        assertOpen();
        const target = this.index.get(type)?.get(this.keyOf(type, this.canonical(uri).text, options));
        if (target) {
          const cycle = this.findPath(target, entry);
          if (cycle) {
            const path = [entry.uri, ...cycle];
            throw new ResourceError('dependency', entry.uri, `Dependency cycle: ${path.join(' → ')}`, {
              path,
              cycle: true,
            });
          }
        }
        const handle = this.acquire<U>(type, uri, options, run.priority, true);
        run.deps.push(handle);
        if (run.kind === 'load') entry.depHandles.value = [...run.deps];
        return handle;
      },

      provide: <U>(type: ResourceType<U>, id: string, value: U) => {
        assertOpen();
        const uri = `${entry.uri.split('#', 1)[0]}#${id}`;
        const child = new ResourceEntry<U>(type, uri, uri, undefined, 'provided');
        child.owner = entry;
        child.value = value;
        child.size = this.sizeOf(this.loaders.get(type)?.[0], value);
        child.version.value = 1;
        child.status.value = 'ready';
        child.done.resolve(value);
        child.refCount = 1;
        const handle = new HandleImpl(child, this);
        run.provided.push(handle);
        return handle;
      },

      service: <S>(key: ServiceKey<S>) => {
        assertOpen();
        if (!this.services.has(key.id)) {
          throw new ResourceError('unsupported', entry.uri, `Service "${key.name}" is not provided`);
        }
        run.services.add(key.id);
        return this.services.get(key.id) as S;
      },

      progress: (loaded, total) => {
        if (run.kind === 'load') entry.selfProgress.value = { loaded, total };
      },
    };
    return ctx;
  }

  /** The chain of URIs from `from` to `to` through the dependencies, if any. */
  private findPath(
    from: ResourceEntry<any>,
    to: ResourceEntry<any>,
    seen = new Set<ResourceEntry<any>>()
  ): string[] | undefined {
    if (from === to) return [from.uri];
    if (seen.has(from)) return undefined;
    seen.add(from);
    for (const h of [...from.deps, ...(from.run?.deps ?? [])]) {
      const sub = this.findPath(h.entry, to, seen);
      if (sub) return [from.uri, ...sub];
    }
    return undefined;
  }

  /** Provided sub-resources become addressable as `uri#id`. */
  private indexProvided(handles: HandleImpl<any>[]): void {
    for (const h of handles) this.entriesOf(h.entry.type).set(h.entry.key, h.entry);
  }

  // ------------------------------------------------------------------
  // Reload
  // ------------------------------------------------------------------

  private reloadEntry(entry: ResourceEntry<any>, replace = false): Promise<void> {
    if (entry.disposed) return Promise.resolve();
    if (entry.kind === 'provided') {
      return entry.owner ? this.reloadEntry(entry.owner, replace) : Promise.resolve();
    }
    if (entry.kind !== 'loaded') return Promise.resolve(); // defined: nothing to read again

    const status = entry.status.peek();
    if (status === 'pending' || status === 'loading') {
      // The first load is still under way: reload as soon as it ends.
      entry.dirty = replace || entry.dirty === 'replace' ? 'replace' : 'update';
      return entry.done.promise.then(noop);
    }
    if (status !== 'ready') return Promise.resolve(); // failed: the next load() retries

    // Coalesce with a reload in flight: its waiters follow the new run.
    const previous = entry.run;
    const waiters = previous ? previous.waiters.splice(0) : [];
    if (previous) this.abortRun(previous);

    const run = this.enqueue(entry, 'reload', 'normal', false, replace || previous?.replace === true);
    const d = deferred<void>();
    run.waiters.push(...waiters, { resolve: () => d.resolve(), reject: (e) => d.reject(e) });
    return d.promise;
  }

  private watchEntry(entry: ResourceEntry<any>): void {
    if (entry.watched || entry.kind !== 'loaded' || entry.disposed) return;
    entry.watched = true;
    const { scheme, path } = parseUri(entry.uri, (s) => this.sources.has(s));
    for (const layer of (scheme !== undefined ? this.sources.get(scheme) : undefined) ?? []) {
      const stop = layer.source.watch?.(path, () => this.onSourceChanged(entry));
      if (stop) entry.unwatch.push(stop);
    }
  }

  private unwatchEntry(entry: ResourceEntry<any>): void {
    entry.watched = false;
    for (const stop of entry.unwatch.splice(0)) stop();
    if (entry.debounce !== undefined) {
      clearTimeout(entry.debounce);
      entry.debounce = undefined;
    }
  }

  private onSourceChanged(entry: ResourceEntry<any>): void {
    if (entry.disposed) return;
    // An editor saves in several steps: one reload per burst.
    if (entry.debounce !== undefined) clearTimeout(entry.debounce);
    entry.debounce = setTimeout(() => {
      entry.debounce = undefined;
      void this.reloadEntry(entry).catch(noop); // the error is on `handle.error`
    }, this.debounceMs);
  }

  private applyStaged(s: Staged): void {
    const entry = s.entry;
    if (entry.staged !== s) return; // superseded, or the entry is gone
    entry.staged = undefined;

    const { loader } = s;
    const old = entry.value;
    const oldDeps = entry.deps;
    const oldOwned = entry.owned;

    let inPlace = false;
    if (!s.replace && loader.update && old !== undefined) {
      try {
        inPlace = loader.update(old, s.value);
      } catch (e) {
        this.warn(`update() of ${entry.uri} failed, replacing instead`, e);
      }
    }

    this.indexProvided(s.provided);
    batch(() => {
      if (inPlace) this.disposeValue(entry.type, loader, s.value); // `next` was only a source
      else entry.value = s.value;
      entry.loader = loader;
      entry.size = this.sizeOf(loader, entry.value);
      entry.deps = s.deps;
      entry.depHandles.value = s.deps;
      entry.owned = s.provided;
      entry.services = s.services;
      entry.error.value = undefined;
      entry.version.value = entry.version.peek() + 1;
    });

    // Whoever uses a sub-resource that was rebuilt must follow its new
    // identity; the old one lives until they let go.
    const stale = new Set<ResourceEntry<any>>();
    for (const h of oldOwned) for (const p of this.parentsOf(h.entry)) stale.add(p);
    stale.delete(entry);

    for (const h of oldDeps) h.release();
    for (const h of oldOwned) h.release();

    if (!inPlace && old !== undefined) {
      // Dependents hold objects made from the old value: it is freed once
      // each of them has switched to the new one.
      const parents = this.parentsOf(entry);
      this.retire(entry.type, loader, old, new Set(parents));
      for (const p of parents) void this.reloadEntry(p).catch(noop);
    }
    for (const p of stale) void this.reloadEntry(p).catch(noop);
    this.settle(entry);

    if (this.idle.has(entry)) this.trim();
  }

  private discardStaged(s: Staged): void {
    const i = this.staged.indexOf(s);
    if (i >= 0) this.staged.splice(i, 1);
    this.disposeValue(s.entry.type, s.loader, s.value);
    for (const h of s.deps) h.release();
    for (const h of s.provided) h.release();
  }

  private retire(
    type: ResourceType<any>,
    loader: ResourceLoader<any, any> | undefined,
    value: unknown,
    waiting: Set<ResourceEntry<any>>
  ): void {
    if (waiting.size === 0) this.disposeValue(type, loader, value);
    else this.retired.push({ loader: loader ?? this.disposerFor(type), value, waiting });
  }

  /** `entry` no longer holds anything made from the values it was waited on for. */
  private settle(entry: ResourceEntry<any>): void {
    for (let i = this.retired.length - 1; i >= 0; i--) {
      const r = this.retired[i];
      if (r.waiting.delete(entry) && r.waiting.size === 0) {
        this.retired.splice(i, 1);
        this.disposeWith(r.loader, r.value);
      }
    }
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private sizeOf(loader: ResourceLoader<any, any> | undefined, value: unknown): number {
    try {
      return loader?.sizeOf?.(value) ?? 0;
    } catch {
      return 0;
    }
  }

  private disposerFor(type: ResourceType<any>): ResourceLoader<any, any> | undefined {
    return this.loaders.get(type)?.find((l) => l.dispose);
  }

  private disposeValue(
    type: ResourceType<any>,
    loader: ResourceLoader<any, any> | undefined,
    value: unknown
  ): void {
    this.disposeWith(loader?.dispose ? loader : this.disposerFor(type), value);
  }

  private disposeWith(loader: ResourceLoader<any, any> | undefined, value: unknown): void {
    try {
      loader?.dispose?.(value);
    } catch (e) {
      this.warn('dispose() threw', e);
    }
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error('ResourceStore is disposed');
  }
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
