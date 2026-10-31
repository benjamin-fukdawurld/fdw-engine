import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
 * The key of a compiled program: the version of DXC, the target, the DXC
 * arguments (stage, entry point, options) and the HLSL.
 */
export function shaderKey(
  dxcVersion: string,
  target: string,
  args: readonly string[],
  hlsl: string,
): string {
  return createHash('sha256')
    .update(`${dxcVersion}\0${target}\0${args.join('\0')}\0\0`)
    .update(hlsl)
    .digest('hex');
}

/**
 * A ShaderCache in a directory, a file per program. The writes go through a
 * temporary file, renamed: a reader never sees half of a program, and two
 * processes writing the same program write the same bytes.
 */
export class FileShaderCache implements ShaderCache {
  /** The programs found, and those compiled, since its creation. */
  hits = 0;
  misses = 0;

  constructor(readonly directory = FileShaderCache.defaultDirectory()) {}

  /**
   * The cache of the hosts: in the default directory, none when
   * FDW_SHADER_CACHE is `off`.
   */
  static fromEnvironment(): FileShaderCache | undefined {
    return process.env['FDW_SHADER_CACHE'] === 'off'
      ? undefined
      : new FileShaderCache();
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
      const code = new Uint8Array(readFileSync(path));
      this.hits++;
      return code;
    } catch {
      this.misses++;
      return undefined;
    }
  }

  set(key: string, code: Uint8Array): void {
    // A cache that cannot be written is only slower.
    try {
      mkdirSync(this.directory, { recursive: true });
      const path = this.#path(key);
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, code);
      renameSync(temporary, path);
    } catch {
      // Compiled at the next run again.
    }
  }

  #path(key: string): string {
    return join(this.directory, `${key}.bin`);
  }
}
