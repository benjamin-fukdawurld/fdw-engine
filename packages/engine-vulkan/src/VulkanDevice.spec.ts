import { existsSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { addonPath } from './addon';
import { VulkanDevice } from './VulkanDevice';
import { canRun } from '@fdw/engine-backend/testing';

// On the GPU, with the validation layer when the Vulkan SDK is set up:
// when the addon is built (it needs the SDK).
const built = canRun(
  'vulkan',
  existsSync(addonPath()),
  'the Vulkan addon is not built (VULKAN_SDK)',
);

describe.skipIf(!built)('VulkanDevice', () => {
  let device: VulkanDevice;
  beforeAll(() => {
    device = new VulkanDevice({ validation: true, application: 'tests' });
  });
  afterAll(() => device?.destroy());
  // Every test leaves the validation layer silent.
  afterEach(() => {
    expect(device.takeMessages()).toEqual([]);
  });

  it('opens a GPU, with the validation layer of the SDK', () => {
    expect(device.name).not.toBe('');
    if (process.env['VULKAN_SDK']) {
      expect(device.validation).toBe(true);
    }
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
