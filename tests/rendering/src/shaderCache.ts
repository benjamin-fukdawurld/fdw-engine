import type { ShaderCache } from '@fdw/engine-vulkan';

/**
 * The programs compiled by DXC, kept in memory for the whole suite of a
 * native backend: a program is compiled by the first test that needs it,
 * the next ones create their modules from the cache. The suite runs the
 * path of a FileShaderCache, and faster.
 */
export function memoryShaderCache(): ShaderCache & {
  readonly hits: number;
  readonly misses: number;
} {
  const programs = new Map<string, Uint8Array>();
  let hits = 0;
  let misses = 0;
  return {
    get: (key) => {
      const code = programs.get(key);
      if (code) hits++;
      else misses++;
      return code;
    },
    set: (key, code) => void programs.set(key, code),
    get hits() {
      return hits;
    },
    get misses() {
      return misses;
    },
  };
}
