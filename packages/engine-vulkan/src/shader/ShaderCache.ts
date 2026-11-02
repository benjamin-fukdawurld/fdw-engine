import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
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
 * version of DXC (`<version>/<hash>`): the programs of an older DXC, never
 * read again, are in a directory of their own, removed as a whole.
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

/**
 * A ShaderCache in a directory, a file per program, in a directory per
 * version of DXC (shaderKey). The writes go through a temporary file,
 * renamed: a reader never sees half of a program, and two processes writing
 * the same program write the same bytes. Each file has the hash of its
 * program: a corrupted file is a miss, compiled again (and the pipeline
 * factory compiles again a program the driver refuses).
 */
export class FileShaderCache implements ShaderCache {
  /** The programs found, and those compiled, since its creation. */
  hits = 0;
  misses = 0;

  constructor(readonly directory = FileShaderCache.defaultDirectory()) {}

  /**
   * The cache of the hosts: in the default directory, none when
   * FDW_SHADER_CACHE is `off`. An application gives the directory of the
   * programs it ships (precompiled), read before the cache of the user.
   */
  static fromEnvironment(shipped?: string): ShaderCache | undefined {
    if (process.env['FDW_SHADER_CACHE'] === 'off') return undefined;
    const cache = new FileShaderCache();
    return shipped && existsSync(shipped)
      ? new LayeredShaderCache(new FileShaderCache(shipped), cache)
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
      if (code) this.hits++;
      else this.misses++;
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
      mkdirSync(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, entry(code));
      renameSync(temporary, path);
    } catch {
      // Compiled at the next run again.
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
