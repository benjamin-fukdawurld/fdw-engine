import { ResourceError } from '../errors';
import type { ReadOptions, ResourceSource } from '../ResourceSource';
import { normalizePath } from '../uri';
import type { ResourceBytes } from '../types';

const encoder = new TextEncoder();

/**
 * Files held in memory: tests, embedded resources. `set` and `delete` notify
 * the watchers, which makes it the reference source for hot reload tests.
 */
export class MemorySource implements ResourceSource {
  private readonly files = new Map<
    string,
    { data: ResourceBytes; revision: number }
  >();
  private readonly watchers = new Map<string, Set<() => void>>();
  private revisionCounter = 0;

  constructor(files?: Record<string, Uint8Array | string>) {
    if (files)
      for (const [path, data] of Object.entries(files)) this.put(path, data);
  }

  private static key(path: string): string {
    return normalizePath(path);
  }

  private put(path: string, data: Uint8Array | string): string {
    const key = MemorySource.key(path);
    const bytes: ResourceBytes =
      typeof data === 'string'
        ? (encoder.encode(data) as ResourceBytes)
        : (new Uint8Array(data) as ResourceBytes); // copy: the caller may reuse its buffer
    this.files.set(key, { data: bytes, revision: ++this.revisionCounter });
    return key;
  }

  /** Adds or replaces a file, and notifies the watchers of the path. */
  set(path: string, data: Uint8Array | string): this {
    this.notify(this.put(path, data));
    return this;
  }

  delete(path: string): boolean {
    const key = MemorySource.key(path);
    const deleted = this.files.delete(key);
    if (deleted) this.notify(key);
    return deleted;
  }

  has(path: string): boolean {
    return this.files.has(MemorySource.key(path));
  }

  private notify(key: string): void {
    for (const cb of [...(this.watchers.get(key) ?? [])]) cb();
  }

  read(path: string, options: ReadOptions): Promise<ResourceBytes> {
    if (options.signal.aborted) {
      return Promise.reject(new ResourceError('aborted', path));
    }
    const file = this.files.get(MemorySource.key(path));
    if (!file) return Promise.reject(new ResourceError('not-found', path));
    options.onProgress?.(file.data.byteLength, file.data.byteLength);
    // A copy: loaders may transfer the buffer (worker decoding).
    return Promise.resolve(new Uint8Array(file.data) as ResourceBytes);
  }

  stat(path: string): Promise<{ size?: number; revision?: string }> {
    const file = this.files.get(MemorySource.key(path));
    if (!file) return Promise.reject(new ResourceError('not-found', path));
    return Promise.resolve({
      size: file.data.byteLength,
      revision: String(file.revision),
    });
  }

  list(prefix: string): Promise<string[]> {
    const p = MemorySource.key(prefix);
    return Promise.resolve(
      [...this.files.keys()].filter((k) => k.startsWith(p)).sort(),
    );
  }

  watch(path: string, onChange: () => void): () => void {
    const key = MemorySource.key(path);
    let set = this.watchers.get(key);
    if (!set) this.watchers.set(key, (set = new Set()));
    set.add(onChange);
    return () => {
      set.delete(onChange);
      if (set.size === 0) this.watchers.delete(key);
    };
  }
}
