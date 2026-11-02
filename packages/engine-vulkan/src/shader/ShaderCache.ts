import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { readdir, rmdir, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * The programs compiled by DXC (SPIR-V, DXIL), kept from a run to the next
 * (design/p11-windows.md §5): with it, the pipeline factory of the native
 * backends compiles a program once, not at each start. By key: shaderKey.
 */
export interface ShaderCache {
  get(key: string): Uint8Array | undefined;
  set(key: string, code: Uint8Array): void;
}

/**
 * The key of a compiled program: the version of DXC (and of dxil.dll for
 * D3D12, in the version the addon tells), the target, the DXC arguments
 * (stage, entry point, options) and the HLSL. Prefixed by a directory per
 * version of DXC (`<version>/<hash>`), readable when looking at the cache.
 * Vulkan and Direct3D 12 tell different versions (D3D12 adds dxil.dll) and
 * share the directory: a version is not "older" for being another, and the
 * programs no longer used go by the eviction of FileShaderCache, the least
 * recently used first.
 */
export function shaderKey(
  dxcVersion: string,
  target: string,
  args: readonly string[],
  hlsl: string,
): string {
  const hash = createHash('sha256')
    .update(`${dxcVersion}\0${target}\0${args.join('\0')}\0\0`)
    .update(hlsl)
    .digest('hex');
  return `${versionDirectory(dxcVersion)}/${hash}`;
}

// The directory of a version of DXC: readable, and unique by its hash.
function versionDirectory(dxcVersion: string): string {
  const name = dxcVersion
    .replace(/[^\w.-]+/g, '_')
    .replace(/^[._]+|[._]+$/g, '')
    .slice(0, 48);
  const hash = createHash('sha256').update(dxcVersion).digest('hex');
  return `dxc-${name}-${hash.slice(0, 8)}`;
}

// The header of an entry: its magic number, then the SHA-256 of the program.
const ENTRY_MAGIC = 0x53574446; // 'FDWS'
const HEADER_SIZE = 4 + 32;

function entry(code: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(HEADER_SIZE + code.byteLength);
  new DataView(bytes.buffer).setUint32(0, ENTRY_MAGIC, true);
  bytes.set(createHash('sha256').update(code).digest(), 4);
  bytes.set(code, HEADER_SIZE);
  return bytes;
}

/**
 * The program of an entry; undefined when the entry is not one (truncated,
 * corrupted, of an older format) or its program is neither SPIR-V nor DXIL.
 */
function program(bytes: Uint8Array): Uint8Array | undefined {
  if (bytes.byteLength < HEADER_SIZE + 4) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== ENTRY_MAGIC) return undefined;
  const code = bytes.subarray(HEADER_SIZE);
  const hash = createHash('sha256').update(code).digest();
  if (!hash.equals(bytes.subarray(4, HEADER_SIZE))) return undefined;
  // SPIR-V (whole words), or a DXIL container ('DXBC').
  const magic = view.getUint32(HEADER_SIZE, true);
  const spirv = magic === 0x07230203 && code.byteLength % 4 === 0;
  return spirv || magic === 0x43425844 ? code : undefined;
}

/** The default bound of a FileShaderCache: 512 MiB, tens of thousands of programs. */
export const defaultShaderCacheMaxSize = 512 * 2 ** 20;

const units: Readonly<Record<string, number>> = {
  '': 1,
  b: 1,
  k: 2 ** 10,
  kb: 2 ** 10,
  kib: 2 ** 10,
  m: 2 ** 20,
  mb: 2 ** 20,
  mib: 2 ** 20,
  g: 2 ** 30,
  gb: 2 ** 30,
  gib: 2 ** 30,
};

/**
 * A size in bytes: a number, or a number and a unit, `512MB`, `1.5GiB`
 * (`KB`, `MB` and `GB` are multiples of 1024, as `KiB`, `MiB` and `GiB`).
 * Undefined for anything else.
 */
export function parseByteSize(text: string): number | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(text);
  const unit = match && units[match[2].toLowerCase()];
  return unit ? Math.floor(Number(match[1]) * unit) : undefined;
}

// FDW_SHADER_CACHE_MAX_SIZE, else the default. A value that is not a size
// is reported and ignored: a cache never stops a host.
function environmentMaxSize(): number {
  const variable = process.env['FDW_SHADER_CACHE_MAX_SIZE'];
  if (variable === undefined || variable === '')
    return defaultShaderCacheMaxSize;
  const size = parseByteSize(variable);
  if (size !== undefined) return size;
  console.warn(
    `FDW_SHADER_CACHE_MAX_SIZE="${variable}" is not a size (as 536870912 or 512MB): ${defaultShaderCacheMaxSize} bytes`,
  );
  return defaultShaderCacheMaxSize;
}

export interface FileShaderCacheOptions {
  /**
   * The bytes the directory may hold: past them, the programs least
   * recently used are removed. FDW_SHADER_CACHE_MAX_SIZE (bytes, or
   * `512MB`), else `defaultShaderCacheMaxSize`. 0: no bound, and the files
   * are only read (a directory of shipped programs).
   */
  readonly maxSize?: number;
}

// The writes between two evictions: an eviction lists the directory.
const EVICTION_INTERVAL = 64;
// A temporary file this old was left by a process that stopped.
const STALE_TEMPORARY_MS = 60 * 60 * 1000;

const errorCode = (e: unknown) => (e as { code?: string }).code;

/**
 * A ShaderCache in a directory, a file per program, in a directory per
 * version of DXC (shaderKey). The writes go through a temporary file,
 * renamed: a reader never sees half of a program, and two processes writing
 * the same program write the same bytes. Each file has the hash of its
 * program: a corrupted file is a miss, compiled again (and the pipeline
 * factory compiles again a program the driver refuses).
 *
 * Its size is bounded (`maxSize`): a hit sets the time of its file, and
 * after the first write of the cache, then every 64 writes, the oldest
 * files of the whole directory (all the versions of DXC, Vulkan and D3D12)
 * are removed until it holds no more than `maxSize`; the directories of a
 * version left empty go too. Several processes can share it: a file another
 * one removed is skipped, and a program removed (racing evictions may
 * remove a few too many) is only compiled again.
 */
export class FileShaderCache implements ShaderCache {
  /** The programs found, and those compiled, since its creation. */
  hits = 0;
  misses = 0;
  /** The bytes the directory may hold; Infinity: unbounded. */
  readonly maxSize: number;
  #writes = 0;
  #eviction?: Promise<void>;

  constructor(
    readonly directory = FileShaderCache.defaultDirectory(),
    options: FileShaderCacheOptions = {},
  ) {
    const maxSize = options.maxSize ?? environmentMaxSize();
    if (!(maxSize >= 0))
      throw new Error(`Invalid shader cache size ${maxSize}`);
    this.maxSize = maxSize === 0 ? Infinity : maxSize;
  }

  /**
   * The cache of the hosts: in the default directory, none when
   * FDW_SHADER_CACHE is `off`. An application gives the directory of the
   * programs it ships (precompiled), read before the cache of the user, and
   * neither evicted nor touched.
   */
  static fromEnvironment(shipped?: string): ShaderCache | undefined {
    if (process.env['FDW_SHADER_CACHE'] === 'off') return undefined;
    const cache = new FileShaderCache();
    return shipped && existsSync(shipped)
      ? new LayeredShaderCache(
          new FileShaderCache(shipped, { maxSize: 0 }),
          cache,
        )
      : cache;
  }

  /**
   * FDW_SHADER_CACHE, else the cache directory of the user:
   * %LOCALAPPDATA%\fdw-engine\shaders, ~/Library/Caches/fdw-engine/shaders,
   * $XDG_CACHE_HOME (or ~/.cache)/fdw-engine/shaders.
   */
  static defaultDirectory(): string {
    const { env } = process;
    if (env['FDW_SHADER_CACHE']) return env['FDW_SHADER_CACHE'];
    const base =
      process.platform === 'win32'
        ? (env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'))
        : process.platform === 'darwin'
          ? join(homedir(), 'Library', 'Caches')
          : (env['XDG_CACHE_HOME'] ?? join(homedir(), '.cache'));
    return join(base, 'fdw-engine', 'shaders');
  }

  get(key: string): Uint8Array | undefined {
    const path = this.#path(key);
    if (!existsSync(path)) {
      this.misses++;
      return undefined;
    }
    try {
      const code = program(new Uint8Array(readFileSync(path)));
      if (code) {
        this.hits++;
        if (this.maxSize !== Infinity) this.#touch(path);
      } else this.misses++;
      return code;
    } catch {
      this.misses++;
      return undefined;
    }
  }

  set(key: string, code: Uint8Array): void {
    // A cache that cannot be written is only slower.
    try {
      const path = this.#path(key);
      const bytes = entry(code);
      const temporary = `${path}.${process.pid}.tmp`;
      const write = () => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(temporary, bytes);
        renameSync(temporary, path);
      };
      try {
        write();
      } catch (e) {
        // Its directory, empty, removed meanwhile by the eviction of
        // another process: made again.
        if (errorCode(e) !== 'ENOENT') throw e;
        write();
      }
    } catch {
      // Compiled at the next run again.
    }
    if (this.#writes++ % EVICTION_INTERVAL === 0) void this.evict();
  }

  /**
   * Removes the programs least recently used (the oldest modification
   * time, which the hits set) until the directory holds no more than
   * `maxSize`, then the directories of a version left empty and the
   * temporary files of processes that stopped. Asynchronous: `set` starts
   * it and does not wait (listing a full cache takes a while); a call while
   * one runs returns it. Safe beside other processes doing the same.
   */
  evict(): Promise<void> {
    if (this.maxSize === Infinity) return Promise.resolve();
    this.#eviction ??= this.#evict()
      .catch(() => undefined)
      .finally(() => (this.#eviction = undefined));
    return this.#eviction;
  }

  async #evict(): Promise<void> {
    const files: { path: string; size: number; time: number }[] = [];
    const directories: string[] = [];
    const now = Date.now();
    const remove = async (path: string): Promise<boolean> => {
      try {
        await unlink(path);
        return true;
      } catch (e) {
        // Removed by another process: gone all the same. Otherwise (in use
        // on Windows, denied) kept.
        return errorCode(e) === 'ENOENT';
      }
    };
    const scan = async (directory: string, depth: number) => {
      let items;
      try {
        items = await readdir(directory, { withFileTypes: true });
      } catch {
        return; // Missing, or removed meanwhile.
      }
      for (const item of items) {
        const path = join(directory, item.name);
        if (item.isDirectory()) {
          // The keys of shaderKey are one directory deep.
          if (depth === 0) {
            directories.push(path);
            await scan(path, 1);
          }
          continue;
        }
        const isProgram = item.name.endsWith('.bin');
        if (!item.isFile() || !(isProgram || item.name.endsWith('.tmp')))
          continue;
        let stats;
        try {
          stats = await stat(path);
        } catch {
          continue; // Removed by another process.
        }
        if (isProgram)
          files.push({ path, size: stats.size, time: stats.mtimeMs });
        else if (now - stats.mtimeMs > STALE_TEMPORARY_MS) await remove(path);
      }
    };
    await scan(this.directory, 0);
    let total = files.reduce((sum, file) => sum + file.size, 0);
    if (total > this.maxSize) {
      files.sort((a, b) => a.time - b.time);
      for (const file of files) {
        if (total <= this.maxSize) break;
        if (await remove(file.path)) total -= file.size;
      }
    }
    // rmdir removes only an empty one: a program written there meanwhile
    // keeps it (and a writer whose directory went makes it again).
    for (const directory of directories)
      await rmdir(directory).catch(() => undefined);
  }

  // Used now: the last to be evicted.
  #touch(path: string): void {
    const now = new Date();
    try {
      utimesSync(path, now, now);
    } catch {
      // Removed meanwhile, or read only: kept as old.
    }
  }

  // The key of shaderKey is `<version>/<hash>`: a file in a directory.
  #path(key: string): string {
    return join(this.directory, ...key.split('/')) + '.bin';
  }
}

/**
 * The programs an application ships (precompiled, read only) over a cache
 * of the user: the programs not shipped (the materials of a level) are
 * compiled once, and kept in the second.
 */
export class LayeredShaderCache implements ShaderCache {
  constructor(
    readonly shipped: ShaderCache,
    readonly cache: ShaderCache,
  ) {}

  get(key: string): Uint8Array | undefined {
    return this.shipped.get(key) ?? this.cache.get(key);
  }

  set(key: string, code: Uint8Array): void {
    this.cache.set(key, code);
  }
}
