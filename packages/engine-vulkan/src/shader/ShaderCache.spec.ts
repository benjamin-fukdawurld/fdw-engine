import { canRun } from '@fdw/engine-backend/testing';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addonPath, loadVulkanAddon } from '../addon';
import { dxcArguments } from './HlslCodegen';
import { FileShaderCache, shaderKey } from './ShaderCache';

describe('shaderKey', () => {
  const args = ['-T', 'cs_6_0', '-E', 'main'];
  it('changes with each of its parts', () => {
    const key = shaderKey('1.8', 'vulkan', args, 'void main() {}');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
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
    first.set('a', new Uint8Array([1, 2, 3, 4]));
    // Another process, later.
    const second = new FileShaderCache(join(directory, 'cache'));
    expect([...(second.get('a') ?? [])]).toEqual([1, 2, 3, 4]);
    expect([second.hits, second.misses, first.misses]).toEqual([1, 0, 1]);
    // No temporary file left.
    expect(readdirSync(join(directory, 'cache'))).toEqual(['a.bin']);
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
