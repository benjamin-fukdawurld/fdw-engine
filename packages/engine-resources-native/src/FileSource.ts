import { readFile, readdir, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  normalizePath,
  ResourceError,
  type ReadOptions,
  type ResourceBytes,
  type ResourceSource,
} from '@fdw/engine-resources';

const missing = (e: unknown): boolean => {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR';
};

/**
 * The files under a directory, as a source. Paths are relative to the root,
 * with `/` on every platform; nothing outside the root can be read.
 * `withFileWatch` adds the change notifications.
 */
export class FileSource implements ResourceSource {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** The file of a path; `not-found` for a path that leaves the root. */
  filePath(path: string): string {
    const file = resolve(this.root, normalizePath(path).replace(/^\/+/, ''));
    const rel = relative(this.root, file);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new ResourceError(
        'not-found',
        path,
        `${path} is outside of ${this.root}`
      );
    }
    return file;
  }

  async read(
    path: string,
    { signal, onProgress }: ReadOptions
  ): Promise<ResourceBytes> {
    if (signal.aborted) throw new ResourceError('aborted', path);
    const file = this.filePath(path);
    let data: Buffer;
    try {
      data = await readFile(file, { signal });
    } catch (e) {
      if ((e as Error).name === 'AbortError')
        throw new ResourceError('aborted', path);
      if (missing(e)) throw new ResourceError('not-found', path);
      throw new ResourceError(
        'io',
        path,
        `Cannot read ${file}: ${(e as Error).message}`,
        { cause: e }
      );
    }
    onProgress?.(data.byteLength, data.byteLength);
    // A Buffer may be a view of a shared pool: the bytes get their own buffer.
    return new Uint8Array(data);
  }

  async stat(path: string): Promise<{ size?: number; revision?: string }> {
    try {
      const info = await stat(this.filePath(path));
      if (!info.isFile()) throw new ResourceError('not-found', path);
      return { size: info.size, revision: `${info.mtimeMs}:${info.size}` };
    } catch (e) {
      if (missing(e)) throw new ResourceError('not-found', path);
      throw e;
    }
  }

  /** The files under a prefix (a directory), recursively, sorted. */
  async list(prefix: string): Promise<string[]> {
    const start = this.filePath(prefix || '.');
    const found: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const full = resolve(directory, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile())
          found.push(relative(this.root, full).split(sep).join('/'));
      }
    };
    try {
      if ((await stat(start)).isFile())
        return [relative(this.root, start).split(sep).join('/')];
      await walk(start);
    } catch (e) {
      if (missing(e)) return [];
      throw e;
    }
    return found.sort();
  }
}
