export interface ReadOptions {
  readonly signal: AbortSignal;
  onProgress?(loaded: number, total?: number): void;
}

export interface ResourceSource {
  read(path: string, options: ReadOptions): Promise<Uint8Array<ArrayBuffer>>;
  // A token that changes when the content does (ETag, mtime), to validate
  // the cache and to detect a change.
  stat?(path: string): Promise<{ size?: number; revision?: string }>;
  list?(prefix: string): Promise<string[]>;
  // The change notifications of a path, for the hot reload. Returns the
  // function that stops watching.
  watch?(path: string, onChange: () => void): () => void;
}
