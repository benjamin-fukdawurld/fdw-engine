import { ResourceError } from '../errors';
import type { ReadOptions, ResourceSource } from '../ResourceSource';
import type { ResourceBytes } from '../types';
import { normalizePath } from '../uri';

export interface ArchiveEntry {
  readonly path: string;
  readonly size: number;
  /** Integrity token, changes with the content. */
  readonly revision: string;
  read(): Promise<ResourceBytes>;
}

/** A format of archive: turns the bytes of an archive into its entries. */
export interface ArchiveReader {
  open(bytes: ResourceBytes): ArchiveEntry[];
}

export type Inflate = (data: Uint8Array<ArrayBuffer>) => Promise<ResourceBytes>;

/** Raw deflate through the platform. Swap in `fflate` where unsupported. */
export const inflateRaw: Inflate = async (data) => {
  if (typeof DecompressionStream === 'undefined') {
    throw new ResourceError(
      'unsupported',
      'zip',
      "DecompressionStream('deflate-raw') is unavailable: pass an `inflate` function (fflate)",
    );
  }
  const stream = new Blob([data])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/**
 * Reads a zip archive: the central directory once, the entries on demand.
 * Stored and deflated entries; no encryption and no ZIP64.
 */
export class ZipReader implements ArchiveReader {
  constructor(private readonly inflate: Inflate = inflateRaw) {}

  open(bytes: ResourceBytes): ArchiveEntry[] {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const bad = (why: string) =>
      new ResourceError('decode', 'zip', `Invalid zip: ${why}`);

    let eocd = -1;
    const min = Math.max(0, bytes.byteLength - 22 - 0xffff);
    for (let i = bytes.byteLength - 22; i >= min; i--) {
      if (view.getUint32(i, true) === SIG_EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw bad('end of central directory not found');

    const count = view.getUint16(eocd + 10, true);
    const cdSize = view.getUint32(eocd + 12, true);
    let offset = view.getUint32(eocd + 16, true);
    if (count === 0xffff || cdSize === 0xffffffff || offset === 0xffffffff) {
      throw new ResourceError(
        'unsupported',
        'zip',
        'ZIP64 archives are not supported',
      );
    }

    const decoder = new TextDecoder('utf-8');
    const entries: ArchiveEntry[] = [];
    for (let n = 0; n < count; n++) {
      if (
        offset + 46 > bytes.byteLength ||
        view.getUint32(offset, true) !== SIG_CENTRAL
      ) {
        throw bad('corrupt central directory');
      }
      const flags = view.getUint16(offset + 8, true);
      const method = view.getUint16(offset + 10, true);
      const crc = view.getUint32(offset + 16, true);
      const csize = view.getUint32(offset + 20, true);
      const size = view.getUint32(offset + 24, true);
      const nameLen = view.getUint16(offset + 28, true);
      const extraLen = view.getUint16(offset + 30, true);
      const commentLen = view.getUint16(offset + 32, true);
      const local = view.getUint32(offset + 42, true);
      const name = decoder.decode(
        bytes.subarray(offset + 46, offset + 46 + nameLen),
      );
      offset += 46 + nameLen + extraLen + commentLen;
      if (name.endsWith('/')) continue; // directory

      const path = normalizePath(name);
      entries.push({
        path,
        size,
        revision: crc.toString(16),
        read: async () => {
          if (flags & 1)
            throw new ResourceError('unsupported', path, 'Encrypted zip entry');
          if (
            local + 30 > bytes.byteLength ||
            view.getUint32(local, true) !== SIG_LOCAL
          ) {
            throw bad(`corrupt local header for ${path}`);
          }
          const start =
            local +
            30 +
            view.getUint16(local + 26, true) +
            view.getUint16(local + 28, true);
          const raw = bytes.subarray(start, start + csize);
          if (method === 0) return new Uint8Array(raw);
          if (method === 8) {
            const out = await this.inflate(raw);
            if (out.byteLength !== size) throw bad(`size mismatch for ${path}`);
            return out;
          }
          throw new ResourceError(
            'unsupported',
            path,
            `Zip compression method ${method}`,
          );
        },
      });
    }
    return entries;
  }
}

export interface ArchiveSourceOptions {
  /** Where the archive lives. */
  readonly source: ResourceSource;
  readonly path: string;
  /** Defaults to a `ZipReader`. */
  readonly reader?: ArchiveReader;
  /** Only the entries under this folder are exposed, relative to it. */
  readonly prefix?: string;
}

/** A source that serves the entries of an archive held by another source. */
export class ArchiveSource implements ResourceSource {
  private index?: Promise<Map<string, ArchiveEntry>>;
  private readonly reader: ArchiveReader;
  private readonly prefix: string;

  constructor(private readonly options: ArchiveSourceOptions) {
    this.reader = options.reader ?? new ZipReader();
    const prefix = options.prefix ? normalizePath(options.prefix) : '';
    this.prefix = prefix && !prefix.endsWith('/') ? prefix + '/' : prefix;
  }

  private load(): Promise<Map<string, ArchiveEntry>> {
    // The archive is read once, and not tied to the signal of whoever asked
    // first: the others would fail with it.
    this.index ??= (async () => {
      const bytes = await this.options.source.read(this.options.path, {
        signal: new AbortController().signal,
      });
      const map = new Map<string, ArchiveEntry>();
      for (const e of this.reader.open(bytes)) {
        if (this.prefix && !e.path.startsWith(this.prefix)) continue;
        map.set(e.path.slice(this.prefix.length), e);
      }
      return map;
    })().catch((e) => {
      this.index = undefined; // retry on the next request
      throw e;
    });
    return this.index;
  }

  private async entry(path: string): Promise<ArchiveEntry> {
    const entry = (await this.load()).get(normalizePath(path));
    if (!entry) throw new ResourceError('not-found', path);
    return entry;
  }

  async read(
    path: string,
    { signal, onProgress }: ReadOptions,
  ): Promise<ResourceBytes> {
    const entry = await this.entry(path);
    if (signal.aborted) throw new ResourceError('aborted', path);
    const data = await entry.read();
    onProgress?.(data.byteLength, data.byteLength);
    return data;
  }

  async stat(path: string): Promise<{ size?: number; revision?: string }> {
    const { size, revision } = await this.entry(path);
    return { size, revision };
  }

  async list(prefix: string): Promise<string[]> {
    const p = normalizePath(prefix);
    return [...(await this.load()).keys()]
      .filter((k) => k.startsWith(p))
      .sort();
  }

  watch(_path: string, onChange: () => void): () => void {
    const inner = this.options.source;
    if (!inner.watch) return () => undefined;
    // The archive changed: the index is stale, and so is every entry.
    return inner.watch(this.options.path, () => {
      this.index = undefined;
      onChange();
    });
  }
}
