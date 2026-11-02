import { canRun } from '@fdw/engine-backend/testing';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addonPath,
  loadVulkanAddon,
  type ContextHandle,
  type ShaderHandle,
  type VulkanAddon,
} from '../addon';
import { VulkanPipelineFactory } from '../render/VulkanPipelineFactory';
import { dxcArguments } from './HlslCodegen';
import {
  defaultShaderCacheMaxSize,
  FileShaderCache,
  LayeredShaderCache,
  parseByteSize,
  shaderKey,
} from './ShaderCache';

describe('shaderKey', () => {
  const args = ['-T', 'cs_6_0', '-E', 'main'];
  it('changes with each of its parts', () => {
    const key = shaderKey('1.8', 'vulkan', args, 'void main() {}');
    // In a directory per version of DXC.
    expect(key).toMatch(/^dxc-1\.8-[0-9a-f]{8}\/[0-9a-f]{64}$/);
    expect(shaderKey('1.8', 'vulkan', args, 'void main() {}')).toBe(key);
    for (const other of [
      shaderKey('1.9', 'vulkan', args, 'void main() {}'),
      shaderKey('1.8', 'd3d12', args, 'void main() {}'),
      shaderKey(
        '1.8',
        'vulkan',
        ['-T', 'cs_6_2', '-E', 'main'],
        'void main() {}',
      ),
      shaderKey('1.8', 'vulkan', args, 'void main() { }'),
    ]) {
      expect(other).not.toBe(key);
    }
    // The arguments do not run into the source.
    expect(shaderKey('1', 'vulkan', ['a'], 'b')).not.toBe(
      shaderKey('1', 'vulkan', ['a', 'b'], ''),
    );
  });
});

// A SPIR-V program: its magic number, then words.
const spirv = (...words: number[]) =>
  new Uint8Array(new Uint32Array([0x07230203, ...words]).buffer);

describe('FileShaderCache', () => {
  let directory: string | undefined;
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it('keeps the programs from a run to the next', () => {
    directory = mkdtempSync(join(tmpdir(), 'fdw-shaders-'));
    const first = new FileShaderCache(join(directory, 'cache'));
    expect(first.get('a')).toBeUndefined();
    first.set('a', spirv(1));
    // Another process, later.
    const second = new FileShaderCache(join(directory, 'cache'));
    expect(second.get('a')).toEqual(spirv(1));
    expect([second.hits, second.misses, first.misses]).toEqual([1, 0, 1]);
    // No temporary file left.
    expect(readdirSync(join(directory, 'cache'))).toEqual(['a.bin']);
  });

  it('keeps the programs of each version of DXC in a directory', () => {
    directory = mkdtempSync(join(tmpdir(), 'fdw-shaders-'));
    const cache = new FileShaderCache(directory);
    const key = shaderKey('1.8.2405 (abc) dxil 1.8', 'd3d12', [], 'x');
    cache.set(key, new TextEncoder().encode('DXBC....'));
    const [version] = readdirSync(directory);
    expect(version).toMatch(/^dxc-1\.8\.2405_abc_dxil_1\.8-[0-9a-f]{8}$/);
    expect(readdirSync(join(directory, version ?? ''))).toEqual([
      `${key.split('/')[1]}.bin`,
    ]);
    expect(cache.get(key)).toEqual(new TextEncoder().encode('DXBC....'));
  });

  it('misses the entries corrupted, truncated, or not a program', () => {
    directory = mkdtempSync(join(tmpdir(), 'fdw-shaders-'));
    const cache = new FileShaderCache(directory);
    cache.set('a', spirv(1, 2));
    const path = join(directory, 'a.bin');
    const bytes = readFileSync(path);
    // A bit flipped in the program: its hash differs.
    const flipped = Buffer.from(bytes);
    flipped[flipped.length - 1] ^= 1;
    writeFileSync(path, flipped);
    expect(cache.get('a')).toBeUndefined();
    // Truncated.
    writeFileSync(path, bytes.subarray(0, bytes.length - 2));
    expect(cache.get('a')).toBeUndefined();
    // A program of before the header.
    writeFileSync(path, spirv(1, 2));
    expect(cache.get('a')).toBeUndefined();
    // Neither SPIR-V nor DXIL, with a right hash.
    cache.set('a', new Uint8Array([1, 2, 3, 4]));
    expect(cache.get('a')).toBeUndefined();
    expect([cache.hits, cache.misses]).toEqual([0, 4]);
    // Written again.
    cache.set('a', spirv(1, 2));
    expect(cache.get('a')).toEqual(spirv(1, 2));
  });

  it('is only slower when it cannot be written', () => {
    directory = mkdtempSync(join(tmpdir(), 'fdw-shaders-'));
    // A file where the directory should be.
    const blocked = join(directory, 'file');
    writeFileSync(blocked, '');
    const cache = new FileShaderCache(join(blocked, 'cache'));
    expect(() => cache.set('a', new Uint8Array([1]))).not.toThrow();
    expect(cache.get('a')).toBeUndefined();
  });

  it('lives in the cache directory of the user, or FDW_SHADER_CACHE', () => {
    const previous = process.env['FDW_SHADER_CACHE'];
    try {
      delete process.env['FDW_SHADER_CACHE'];
      expect(FileShaderCache.defaultDirectory()).toMatch(
        /fdw-engine[\\/]shaders$/,
      );
      process.env['FDW_SHADER_CACHE'] = '/somewhere';
      expect(new FileShaderCache().directory).toBe('/somewhere');
    } finally {
      if (previous === undefined) delete process.env['FDW_SHADER_CACHE'];
      else process.env['FDW_SHADER_CACHE'] = previous;
    }
  });
});

describe('the eviction of FileShaderCache', () => {
  let directory = '';
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = '';
  });
  // An entry of spirv(1): its header, 36 bytes, then 8 bytes.
  const entrySize = 44;
  // Two versions of DXC, as Vulkan and D3D12 write them side by side.
  const keys = ['dxc-vulkan-0/x', 'dxc-d3d12-1/y', 'dxc-d3d12-1/z'] as const;
  const file = (key: string) => join(directory, ...key.split('/')) + '.bin';
  // Sets the time of an entry, `age` seconds ago.
  const age = (key: string, seconds: number) => {
    const time = new Date(Date.now() - seconds * 1000);
    utimesSync(file(key), time, time);
  };
  const fill = async (cache: FileShaderCache) => {
    for (const key of keys) cache.set(key, spirv(1));
    await cache.evict();
    keys.forEach((key, i) => age(key, 300 - i * 100));
  };

  it('removes the entries least recently used, across the versions of DXC', async () => {
    directory = mkdtempSync(join(tmpdir(), 'fdw-shaders-'));
    const cache = new FileShaderCache(directory, { maxSize: 2 * entrySize });
    await fill(cache);
    // x, the oldest written, read now: y is the least recently used.
    expect(cache.get(keys[0])).toEqual(spirv(1));
    await cache.evict();
    expect(keys.map((key) => existsSync(file(key)))).toEqual([
      true,
      false,
      true,
    ]);
  });

  it('removes the directories of a version left empty, and old temporary files', async () => {
    directory = mkdtempSync(join(tmpdir(), 'fdw-shaders-'));
    const cache = new FileShaderCache(directory, { maxSize: entrySize });
    await fill(cache);
    age(keys[0], 0);
    // Left by a process that stopped, and by one still writing.
    const stale = `${file(keys[0])}.1.tmp`;
    const fresh = `${file(keys[0])}.2.tmp`;
    writeFileSync(stale, '');
    writeFileSync(fresh, '');
    const old = new Date(Date.now() - 2 * 3600 * 1000);
    utimesSync(stale, old, old);
    await cache.evict();
    expect(readdirSync(directory)).toEqual(['dxc-vulkan-0']);
    expect(readdirSync(join(directory, 'dxc-vulkan-0')).sort()).toEqual([
      'x.bin',
      'x.bin.2.tmp',
    ]);
  });

  it('evicts after the first write, then every 64 writes', async () => {
    directory = mkdtempSync(join(tmpdir(), 'fdw-shaders-'));
    // Another process filled it past the size.
    const other = new FileShaderCache(directory, { maxSize: 0 });
    for (let i = 0; i < 10; i++) other.set(`dxc-a-0/${i}`, spirv(1));
    const cache = new FileShaderCache(directory, { maxSize: 5 * entrySize });
    cache.set('dxc-a-0/first', spirv(1));
    await cache.evict();
    expect(readdirSync(join(directory, 'dxc-a-0'))).toHaveLength(5);
    // Not before the 64th write.
    for (let i = 0; i < 63; i++) other.set(`dxc-a-0/o${i}`, spirv(1));
    for (let i = 1; i < 64; i++) cache.set(`dxc-a-0/${i}`, spirv(1));
    expect(readdirSync(join(directory, 'dxc-a-0')).length).toBeGreaterThan(5);
    cache.set('dxc-a-0/64', spirv(1));
    await cache.evict();
    expect(readdirSync(join(directory, 'dxc-a-0'))).toHaveLength(5);
  });

  it('is safe with processes evicting the same directory', async () => {
    directory = mkdtempSync(join(tmpdir(), 'fdw-shaders-'));
    const writer = new FileShaderCache(directory, { maxSize: 0 });
    for (let i = 0; i < 50; i++) writer.set(`dxc-a-${i % 2}/${i}`, spirv(1));
    const caches = [1, 2, 3].map(
      () => new FileShaderCache(directory, { maxSize: 10 * entrySize }),
    );
    await Promise.all(caches.map((cache) => cache.evict()));
    const left = readdirSync(directory).flatMap((version) =>
      readdirSync(join(directory, version)),
    );
    // None fails; racing, they may remove more than needed (on Windows, a
    // file another one is removing is in use), which only costs compiles.
    expect(left.length).toBeLessThanOrEqual(10);
  });

  it('neither evicts nor touches when unbounded (programs shipped)', async () => {
    directory = mkdtempSync(join(tmpdir(), 'fdw-shaders-'));
    const cache = new FileShaderCache(directory, { maxSize: 0 });
    expect(cache.maxSize).toBe(Infinity);
    await fill(cache);
    const before = statSync(file(keys[0])).mtimeMs;
    expect(cache.get(keys[0])).toEqual(spirv(1));
    expect(statSync(file(keys[0])).mtimeMs).toBe(before);
    expect(keys.every((key) => existsSync(file(key)))).toBe(true);
  });

  it('takes its size from FDW_SHADER_CACHE_MAX_SIZE, in bytes or with a unit', () => {
    const previous = process.env['FDW_SHADER_CACHE_MAX_SIZE'];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      delete process.env['FDW_SHADER_CACHE_MAX_SIZE'];
      expect(new FileShaderCache('unused').maxSize).toBe(
        defaultShaderCacheMaxSize,
      );
      process.env['FDW_SHADER_CACHE_MAX_SIZE'] = '64MB';
      expect(new FileShaderCache('unused').maxSize).toBe(64 * 2 ** 20);
      // The option comes first.
      expect(new FileShaderCache('unused', { maxSize: 10 }).maxSize).toBe(10);
      process.env['FDW_SHADER_CACHE_MAX_SIZE'] = '0';
      expect(new FileShaderCache('unused').maxSize).toBe(Infinity);
      // Not a size: reported, the default kept.
      process.env['FDW_SHADER_CACHE_MAX_SIZE'] = 'big';
      expect(new FileShaderCache('unused').maxSize).toBe(
        defaultShaderCacheMaxSize,
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/FDW_SHADER_CACHE_MAX_SIZE="big"/),
      );
    } finally {
      warn.mockRestore();
      if (previous === undefined)
        delete process.env['FDW_SHADER_CACHE_MAX_SIZE'];
      else process.env['FDW_SHADER_CACHE_MAX_SIZE'] = previous;
    }
    expect(parseByteSize('1.5GiB')).toBe(1.5 * 2 ** 30);
    expect(parseByteSize('2048')).toBe(2048);
    expect(parseByteSize('1 kb')).toBe(1024);
    expect(parseByteSize('-1')).toBeUndefined();
    expect(parseByteSize('12 parsecs')).toBeUndefined();
  });
});

describe('LayeredShaderCache', () => {
  let directory: string | undefined;
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it('reads the programs shipped first, writes into the cache of the user', () => {
    directory = mkdtempSync(join(tmpdir(), 'fdw-shaders-'));
    const shipped = new FileShaderCache(join(directory, 'shipped'));
    shipped.set('a', spirv(1));
    const user = new FileShaderCache(join(directory, 'user'));
    user.set('a', spirv(2));
    const cache = new LayeredShaderCache(shipped, user);
    expect(cache.get('a')).toEqual(spirv(1));
    expect(cache.get('b')).toBeUndefined();
    cache.set('b', spirv(3));
    expect(readdirSync(join(directory, 'shipped'))).toEqual(['a.bin']);
    expect(cache.get('b')).toEqual(spirv(3));
  });

  it('is what the hosts get when the application ships programs', () => {
    directory = mkdtempSync(join(tmpdir(), 'fdw-shaders-'));
    const previous = process.env['FDW_SHADER_CACHE'];
    try {
      process.env['FDW_SHADER_CACHE'] = join(directory, 'user');
      expect(FileShaderCache.fromEnvironment(directory)).toBeInstanceOf(
        LayeredShaderCache,
      );
      // Nothing shipped there.
      expect(
        FileShaderCache.fromEnvironment(join(directory, 'none')),
      ).toBeInstanceOf(FileShaderCache);
      process.env['FDW_SHADER_CACHE'] = 'off';
      expect(FileShaderCache.fromEnvironment(directory)).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env['FDW_SHADER_CACHE'];
      else process.env['FDW_SHADER_CACHE'] = previous;
    }
  });
});

describe('the pipeline factory and its cache', () => {
  // An addon that compiles to a word, and refuses the programs of the
  // previous version (as the native side refuses a corrupted program).
  const addon = () => {
    const calls = { compiled: 0, created: 0 };
    const fake = {
      dxcVersion: () => '1.8',
      compileHlsl: () => {
        calls.compiled++;
        return spirv(2);
      },
      createShaderFromCode: (_: ContextHandle, code: Uint8Array) => {
        if (code[4] !== 2) throw new Error('The code is not SPIR-V');
        calls.created++;
        return {} as ShaderHandle;
      },
    };
    return { calls, addon: fake as unknown as VulkanAddon };
  };
  const createShader = (factory: VulkanPipelineFactory) =>
    (
      factory as unknown as {
        createShader(hlsl: string, args: string[], label: string): unknown;
      }
    ).createShader('void main() {}', ['-T', 'cs_6_0'], 'test');

  it('compiles again a program the native side refuses, and replaces it', () => {
    const { calls, addon: fake } = addon();
    const entries = new Map<string, Uint8Array>();
    const factory = new VulkanPipelineFactory(fake, {} as ContextHandle);
    factory.shaderCache = {
      get: (key) => entries.get(key),
      set: (key, code) => void entries.set(key, code),
    };
    createShader(factory);
    expect(calls).toEqual({ compiled: 1, created: 1 });
    createShader(factory);
    expect(calls).toEqual({ compiled: 1, created: 2 });
    // Refused: compiled again, then read.
    const [key] = entries.keys();
    entries.set(key ?? '', spirv(9));
    createShader(factory);
    expect(calls).toEqual({ compiled: 2, created: 3 });
    expect(entries.get(key ?? '')).toEqual(spirv(2));
  });
});

const built = canRun(
  'vulkan',
  existsSync(addonPath()),
  'the Vulkan addon is not built (VULKAN_SDK)',
);

describe.skipIf(!built)('the compilation for a cache', () => {
  const hlsl = '[numthreads(1, 1, 1)] void cs_main() {}';

  it('compiles to SPIR-V without a module, and tells the version of DXC', () => {
    const addon = loadVulkanAddon();
    expect(addon.dxcVersion()).toMatch(/^\d+\.\d+/);
    const code = addon.compileHlsl(
      hlsl,
      dxcArguments('compute', 'cs_main', 'vulkan', hlsl),
    );
    // The magic number of SPIR-V.
    expect(new DataView(code.buffer, code.byteOffset).getUint32(0, true)).toBe(
      0x07230203,
    );
  });

  it('reports the errors of DXC', () => {
    expect(() =>
      loadVulkanAddon().compileHlsl(
        'not hlsl',
        dxcArguments('compute', 'cs_main', 'vulkan', 'not hlsl'),
      ),
    ).toThrow(/DXC/);
  });
});
