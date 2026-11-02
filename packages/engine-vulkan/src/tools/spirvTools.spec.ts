import { describe, expect, it } from 'vitest';
import type { ShaderCache } from '../shader/ShaderCache';
import {
  checkSpirv,
  compileHlsl,
  findTool,
  withTemporaryDirectory,
} from './spirvTools';

const sdk = !!(
  findTool('dxc') &&
  findTool('spirv-val') &&
  findTool('spirv-cross')
);

const sources = {
  kind: 'single-module' as const,
  code: `
cbuffer Params : register(b1) { float4 scale; float bias; };
RWStructuredBuffer<float> values : register(u0);
[numthreads(1, 1, 1)]
void main() { values[0] = scale.x + bias; }
`,
  entryPoints: { compute: 'main' },
};

// A ShaderCache in memory, counting its reads.
function memoryCache(): ShaderCache & { hits: number; misses: number } {
  const programs = new Map<string, Uint8Array>();
  const cache = {
    hits: 0,
    misses: 0,
    get: (key: string) => {
      const code = programs.get(key);
      if (code) cache.hits++;
      else cache.misses++;
      return code;
    },
    set: (key: string, code: Uint8Array) => void programs.set(key, code),
  };
  return cache;
}

describe.skipIf(!sdk)('The tools of the Vulkan SDK', () => {
  it('compile a program once with a cache', async () => {
    const cache = memoryCache();
    const first = await compileHlsl(sources, { cache });
    const second = await compileHlsl(sources, { cache });
    expect([cache.misses, cache.hits]).toEqual([1, 1]);
    expect(second.get('compute')).toEqual(first.get('compute'));
  });

  it('validate and reflect a module from one directory', async () => {
    const blocks = await withTemporaryDirectory(async (dir) => {
      const modules = await compileHlsl(sources, { dir });
      return checkSpirv(modules.get('compute')!, dir);
    });
    const params = [...blocks.values()][0];
    expect([params.set, params.binding]).toEqual([0, 1]);
    expect(params.members.map((member) => member.offset)).toEqual([0, 16]);
  });

  it('report the messages of an invalid module', async () => {
    await expect(
      withTemporaryDirectory((dir) =>
        checkSpirv(new Uint8Array([3, 2, 35, 7, 0, 0, 0, 0]), dir),
      ),
    ).rejects.toThrow(/spirv-val|spirv-cross/);
  });
});
