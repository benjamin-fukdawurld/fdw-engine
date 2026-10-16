import {
  normalizePath,
  ResourceError,
  type ReadOptions,
  type ResourceBytes,
  type ResourceSource,
} from '@fdw/engine-resources';

/**
 * Browser `File` objects as a source: an `<input type="file">`, a dropped
 * folder. For importers and editors. Adding a file under an existing path
 * replaces it and notifies the watchers, which hot-reloads what used it.
 */
export class FileSource implements ResourceSource {
  private readonly files = new Map<string, File>();
  private readonly watchers = new Map<string, Set<() => void>>();

  /** The path defaults to the relative path of a picked folder, else the name. */
  add(file: File, path?: string): this {
    const key = normalizePath(path ?? (file.webkitRelativePath || file.name));
    this.files.set(key, file);
    for (const cb of [...(this.watchers.get(key) ?? [])]) cb();
    return this;
  }

  addAll(files: Iterable<File>): this {
    for (const file of files) this.add(file);
    return this;
  }

  /**
   * Adds the files and folders of a drop. The entries are taken before the
   * first `await`: the browser empties the `DataTransfer` when the event ends.
   * Returns the paths added.
   */
  async addFromDataTransfer(data: DataTransfer): Promise<string[]> {
    const entries = [...data.items]
      .filter((item) => item.kind === 'file')
      .map((item) => item.webkitGetAsEntry?.() ?? null)
      .filter((entry): entry is FileSystemEntry => entry !== null);
    const added: string[] = [];
    for (const entry of entries) await this.walk(entry, added);
    return added;
  }

  private async walk(entry: FileSystemEntry, added: string[]): Promise<void> {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject)
      );
      const path = entry.fullPath.replace(/^\/+/, '');
      this.add(file, path);
      added.push(normalizePath(path));
      return;
    }
    if (!entry.isDirectory) return;
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // `readEntries` returns a batch at a time, until an empty one.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject)
      );
      if (batch.length === 0) break;
      for (const child of batch) await this.walk(child, added);
    }
  }

  remove(path: string): boolean {
    const key = normalizePath(path);
    const removed = this.files.delete(key);
    if (removed) for (const cb of [...(this.watchers.get(key) ?? [])]) cb();
    return removed;
  }

  clear(): void {
    this.files.clear();
  }

  private file(path: string): File {
    const file = this.files.get(normalizePath(path));
    if (!file) throw new ResourceError('not-found', path);
    return file;
  }

  async read(path: string, { signal, onProgress }: ReadOptions): Promise<ResourceBytes> {
    const file = this.file(path);
    if (signal.aborted) throw new ResourceError('aborted', path);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (signal.aborted) throw new ResourceError('aborted', path);
    onProgress?.(bytes.byteLength, bytes.byteLength);
    return bytes;
  }

  async stat(path: string): Promise<{ size?: number; revision?: string }> {
    const file = this.file(path);
    return { size: file.size, revision: String(file.lastModified) };
  }

  async list(prefix: string): Promise<string[]> {
    const p = normalizePath(prefix);
    return [...this.files.keys()].filter((k) => k.startsWith(p)).sort();
  }

  watch(path: string, onChange: () => void): () => void {
    const key = normalizePath(path);
    let set = this.watchers.get(key);
    if (!set) this.watchers.set(key, (set = new Set()));
    set.add(onChange);
    return () => {
      set.delete(onChange);
      if (set.size === 0) this.watchers.delete(key);
    };
  }
}
