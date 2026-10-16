import type { ResourceBytes } from './types';

export interface ReadOptions {
  readonly signal: AbortSignal;
  onProgress?(loaded: number, total?: number): void;
}

export interface ResourceSource {
  /**
   * Reads the bytes of a path (without scheme). Throws
   * `ResourceError('not-found')` when the path does not exist: the store then
   * tries the next source mounted under the same scheme.
   */
  read(path: string, options: ReadOptions): Promise<ResourceBytes>;
  // A token that changes when the content does (ETag, mtime), to validate
  // the cache and to detect a change.
  stat?(path: string): Promise<{ size?: number; revision?: string }>;
  list?(prefix: string): Promise<string[]>;
  // The change notifications of a path, for the hot reload. Returns the
  // function that stops watching.
  watch?(path: string, onChange: () => void): () => void;
}
