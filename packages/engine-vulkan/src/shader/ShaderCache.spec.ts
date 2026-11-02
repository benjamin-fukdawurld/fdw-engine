import { canRun } from '@fdw/engine-backend/testing';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addonPath,
  loadVulkanAddon,
  type ContextHandle,
  type ShaderHandle,
  type VulkanAddon,
} from '../addon';
import { VulkanPipelineFactory } from '../render/VulkanPipelineFactory';
import { dxcArguments } from './HlslCodegen';
import { FileShaderCache, LayeredShaderCache, shaderKey } from './ShaderCache';

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
