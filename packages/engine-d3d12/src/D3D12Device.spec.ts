import { existsSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { dxcArguments } from '@fdw/engine-vulkan';
import { addonPath, loadD3D12Addon } from './addon';
import { D3D12Device } from './D3D12Device';
import { canRun } from '@fdw/engine-backend/testing';

// On the GPU, with the debug layer when the Graphics Tools of Windows are installed:
// when the addon is built (Windows only).
const built = canRun(
  'd3d12',
  existsSync(addonPath()),
  'the Direct3D 12 addon is not built (Windows only)',
);

describe.skipIf(!built)('D3D12Device', () => {
  let device: D3D12Device;
  beforeAll(() => {
    device = new D3D12Device({ validation: true, application: 'tests' });
  });
  afterAll(() => device?.destroy());
  // Every test leaves the debug layer silent.
  afterEach(() => {
    expect(device.takeMessages()).toEqual([]);
  });

  it('opens a GPU', () => {
    expect(device.name).not.toBe('');
  });

  it('writes buffers and reads them back', async () => {
    const buffer = device.buffers.create({
      size: 16,
      usage: ['uniform', 'copy-dst'],
      label: 'round trip',
      initialData: new Uint32Array([1, 2, 3, 4]),
    });
    buffer.write(4, new Uint32Array([7, 8]).buffer);
    expect([...new Uint32Array(await buffer.read())]).toEqual([1, 7, 8, 4]);
    // A range, and a part of the source data.
    buffer.write(0, new Uint32Array([9, 10, 11]).buffer, 4, 8);
    expect([...new Uint32Array(await buffer.read(0, 8))]).toEqual([10, 11]);
    buffer.destroy();
  });

  it('applies the writes in order, and reads after them', async () => {
    const buffer = device.buffers.create({ size: 1024, usage: ['storage'] });
    const reads: Promise<ArrayBuffer>[] = [];
    for (let i = 0; i < 20; i++) {
      // Overlapping writes: the last one wins.
      buffer.write(0, new Float32Array(256).fill(i).buffer);
      reads.push(buffer.read(0, 4));
    }
    const values = (await Promise.all(reads)).map(
      (data) => new Float32Array(data)[0],
    );
    expect(values).toEqual(Array.from({ length: 20 }, (_, i) => i));
    buffer.destroy();
  });

  it('keeps a destroyed buffer until the GPU is done with it', async () => {
    const buffer = device.buffers.create({ size: 64, usage: ['vertex'] });
    buffer.write(0, new Uint8Array(64).fill(5).buffer);
    const pending = buffer.read();
    buffer.destroy();
    expect(new Uint8Array(await pending)[63]).toBe(5);
    expect(() => buffer.write(0, new ArrayBuffer(4))).toThrow(/destroyed/);
    device.waitIdle();
  });

  it('reports the misuses', () => {
    const buffer = device.buffers.create({ size: 8, usage: ['index'] });
    expect(() => buffer.write(4, new ArrayBuffer(8))).toThrow(
      /outside of the buffer \(8 bytes\)/,
    );
    buffer.destroy();
  });
});

describe.skipIf(!built)('D3D12Device on WARP', () => {
  it('opens the software rasterizer of Windows', async () => {
    const device = new D3D12Device({ application: 'tests', adapter: 'warp' });
    try {
      expect(device.name).toBe('Microsoft Basic Render Driver');
      const buffer = device.buffers.create({
        size: 8,
        usage: ['storage'],
        initialData: new Uint32Array([3, 4]),
      });
      expect([...new Uint32Array(await buffer.read())]).toEqual([3, 4]);
      buffer.destroy();
    } finally {
      device.destroy();
    }
  });
});

describe.skipIf(!built)('the compilation for a cache', () => {
  it('compiles to DXIL without a shader, and tells the version of DXC', () => {
    const addon = loadD3D12Addon();
    const hlsl = '[numthreads(1, 1, 1)] void cs_main() {}';
    expect(addon.dxcVersion()).toMatch(/^\d+\.\d+/);
    const code = addon.compileHlsl(
      hlsl,
      dxcArguments('compute', 'cs_main', 'd3d12', hlsl),
    );
    // A DXIL container.
    expect(new TextDecoder().decode(code.subarray(0, 4))).toBe('DXBC');
  });
});
