import { ResourceError } from '../errors';
import type { ReadOptions, ResourceSource } from '../ResourceSource';
import type { ResourceBytes } from '../types';
import { normalizePath } from '../uri';

export interface CatalogSourceOptions {
  /** Where the files are. */
  readonly source: ResourceSource;
  /** The path of each identifier in the source: `{ '8d42c7e1': 'trees/oak.glb' }`. */
  readonly entries?: Readonly<Record<string, string>>;
}

/**
 * Stable identifiers over the paths of another source: mounted under a
 * scheme (`store.mount('asset', catalog)`), `asset:8d42c7e1` reads
 * `trees/oak.glb`, and a scene referencing the identifier survives the
 * file being moved (`set` the new path: what is loaded reloads). A path
 * that is not an identifier is read as it is, from the root of the source:
 * prefer the files that hold their dependencies (`.glb`).
 */
export class CatalogSource implements ResourceSource {
  private readonly entries = new Map<string, string>();
  private readonly watchers = new Map<string, Set<() => void>>();

  constructor(private readonly options: CatalogSourceOptions) {
    for (const [id, path] of Object.entries(options.entries ?? {}))
      this.entries.set(id, normalizePath(path));
  }

  /** The path of an identifier, if known. */
  pathOf(id: string): string | undefined {
    return this.entries.get(normalizePath(id));
  }

  /** Gives an identifier a path (a new one, or a file moved): its watchers reload. */
  set(id: string, path: string): this {
    const key = normalizePath(id);
    this.entries.set(key, normalizePath(path));
    this.watchers.get(key)?.forEach((notify) => notify());
    return this;
  }

  /** Forgets an identifier. */
  delete(id: string): this {
    const key = normalizePath(id);
    this.entries.delete(key);
    this.watchers.get(key)?.forEach((notify) => notify());
    return this;
  }

  private target(path: string): string {
    return this.entries.get(normalizePath(path)) ?? normalizePath(path);
  }

  read(path: string, options: ReadOptions): Promise<ResourceBytes> {
    return this.options.source.read(this.target(path), options);
  }

  async stat(path: string): Promise<{ size?: number; revision?: string }> {
    const { source } = this.options;
    if (!source.stat) throw new ResourceError('unsupported', path, 'No stat');
    return source.stat(this.target(path));
  }

  async list(prefix: string): Promise<string[]> {
    const p = normalizePath(prefix);
    return [...this.entries.keys()].filter((id) => id.startsWith(p)).sort();
  }

  watch(path: string, onChange: () => void): () => void {
    const key = normalizePath(path);
    let set = this.watchers.get(key);
    if (!set) this.watchers.set(key, (set = new Set()));
    set.add(onChange);
    // The file itself changing: the source of the path it has now.
    const inner = this.options.source.watch?.(this.target(path), onChange);
    return () => {
      set.delete(onChange);
      inner?.();
    };
  }
}
