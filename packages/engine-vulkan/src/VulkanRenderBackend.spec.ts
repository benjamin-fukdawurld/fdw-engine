import { existsSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { addonPath } from './addon';
import { VulkanEngine } from './VulkanEngine';
import { VulkanOffscreenSurface } from './VulkanOffscreenSurface';
import { compressedBlock } from '@fdw/engine-backend';
import { canRun } from '@fdw/engine-backend/testing';

const built = canRun(
  'vulkan',
  existsSync(addonPath()),
  'the Vulkan addon is not built (VULKAN_SDK)'
);

describe.skipIf(!built)('VulkanRenderBackend: textures and passes', () => {
  let engine: VulkanEngine;
  beforeAll(async () => {
    engine = new VulkanEngine({ validation: true, application: 'tests' });
    await engine.init();
  });
  afterAll(() => engine?.destroy());
  afterEach(() => {
    expect(engine.device?.takeMessages()).toEqual([]);
  });

  const backend = () => {
    if (!engine.backend) {
      throw new Error('The engine is not ready');
    }
    return engine.backend;
  };

  it('clears render targets, read back row by row from the top', async () => {
    const surface = new VulkanOffscreenSurface(4, 2);
    await surface.init(engine);
    const encoder = backend().createCommandEncoder();
    encoder
      .beginRenderPass({
        colorAttachments: [
          {
            target: surface.getCurrentTarget(),
            load: 'clear',
            clearValue: { r: 1, g: 0.2, b: 0, a: 1 },
          },
        ],
      })
      .end();
    backend().submit([encoder.finish()]);
    const pixels = await surface.readPixels();
    expect(pixels.length).toBe(4 * 2 * 4);
    expect([...pixels.subarray(0, 4)]).toEqual([255, 51, 0, 255]);
    expect([...pixels.subarray(28, 32)]).toEqual([255, 51, 0, 255]);
    surface.destroy();
  });

  it('writes textures and reads them back', async () => {
    // 2 × 2: red, green / blue, white, rows from the top.
    const data = new Uint8Array([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
    ]);
    const texture = backend().textures.createTexture({
      type: '2d',
      format: 'rgba8unorm',
      dimensions: { width: 2, height: 2 },
      usage: ['sampled', 'copy-src', 'copy-dst'],
      source: data,
    });
    expect(new Uint8Array(await texture.read())).toEqual(data);
    // Half floats: 8 bytes per pixel.
    const hdr = backend().textures.createTexture({
      type: '2d',
      format: 'rgba16float',
      dimensions: { width: 3, height: 1 },
      usage: ['sampled', 'copy-src', 'copy-dst'],
      source: new Uint16Array(12).fill(0x3c00),
    });
    expect([...new Uint16Array(await hdr.read())]).toEqual(
      Array(12).fill(0x3c00)
    );
    // A region: the second column, rows from the top.
    expect(
      new Uint8Array(await texture.read({ x: 1, y: 0, width: 1, height: 2 }))
    ).toEqual(data.filter((_, i) => i % 8 >= 4));
    expect(() => texture.read({ x: 1, y: 1, width: 2, height: 1 })).toThrow(
      /not inside/
    );
    texture.destroy();
    hdr.destroy();
  });

  it('writes the levels given, and a level alone', async () => {
    const pixels = (count: number, color: number[]) =>
      Uint8Array.from({ length: count * 4 }, (_, i) => color[i % 4]);
    const texture = backend().textures.createTexture({
      type: '2d',
      format: 'rgba8unorm',
      dimensions: { width: 4, height: 4 },
      usage: ['sampled', 'copy-src', 'copy-dst'],
      levels: [
        pixels(16, [255, 0, 0, 255]),
        pixels(4, [0, 255, 0, 255]),
        pixels(1, [0, 0, 255, 255]),
      ],
    });
    expect(texture.mipLevelCount).toBe(3);
    expect([...new Uint8Array(await texture.read()).subarray(0, 4)]).toEqual([
      255, 0, 0, 255,
    ]);
    // The first level is kept.
    backend().textures.writeTexture(texture, pixels(4, [9, 9, 9, 9]), {
      level: 1,
    });
    expect([...new Uint8Array(await texture.read()).subarray(60)]).toEqual([
      255, 0, 0, 255,
    ]);
    expect(() =>
      backend().textures.writeTexture(texture, pixels(2, [0, 0, 0, 0]), {
        level: 1,
      })
    ).toThrow(/level 1 takes 16 bytes, not 8/);

    // A face of a cube: the others are kept.
    const cube = backend().textures.createTexture({
      type: 'cube',
      format: 'rgba8unorm',
      dimensions: { width: 2, height: 2, layers: 6 },
      usage: ['sampled', 'copy-src', 'copy-dst'],
      source: pixels(24, [1, 2, 3, 4]),
    });
    backend().textures.writeTexture(cube, pixels(4, [5, 6, 7, 8]), {
      layer: 3,
    });
    // The first face is read back.
    expect([...new Uint8Array(await cube.read()).subarray(0, 4)]).toEqual([
      1, 2, 3, 4,
    ]);
    texture.destroy();
    cube.destroy();
  });

  it('writes the compressed formats the device has', () => {
    const formats = backend().capabilities.compressedFormats ?? [];
    for (const format of formats) {
      // 8 × 8 with 4 levels: 4 blocks, then 1 for 4 × 4, 2 × 2 and 1 × 1.
      const bytes = compressedBlock(format)?.bytes ?? 0;
      const texture = backend().textures.createTexture({
        type: '2d',
        format,
        dimensions: { width: 8, height: 8 },
        usage: ['sampled', 'copy-src', 'copy-dst'],
        levels: [4, 1, 1, 1].map((blocks) => new Uint8Array(blocks * bytes)),
      });
      backend().textures.writeTexture(texture, new Uint8Array(bytes), {
        level: 2,
      });
      expect(() => texture.read()).toThrow(/cannot be read back/);
      texture.destroy();
    }
    expect(() =>
      backend().textures.createTexture({
        type: '2d',
        format: 'bc7-rgba-unorm',
        dimensions: { width: 4, height: 4 },
        source: new Uint8Array(4),
      })
    ).toThrow(
      formats.includes('bc7-rgba-unorm')
        ? /takes 16 bytes, not 4/
        : /not supported by the device/
    );
  });

  it('keeps the content of a loaded attachment, and copies textures', async () => {
    const color = backend().createRenderTarget({
      width: 8,
      height: 8,
      format: 'rgba8unorm',
    });
    const depth = backend().textures.createTexture({
      type: '2d',
      format: backend().depthFormat,
      dimensions: { width: 8, height: 8 },
      usage: ['render-attachment'],
    });
    const surface = new VulkanOffscreenSurface(8, 8);
    await surface.init(engine);
    const encoder = backend().createCommandEncoder();
    encoder
      .beginRenderPass({
        colorAttachments: [
          {
            target: color,
            load: 'clear',
            clearValue: { r: 0, g: 0, b: 1, a: 1 },
          },
        ],
        depthAttachment: { target: depth, load: 'clear', clearValue: 1 },
      })
      .end();
    // Loaded: the clear stays.
    encoder
      .beginRenderPass({
        colorAttachments: [{ target: color, load: 'load' }],
        depthAttachment: { target: depth, load: 'load' },
      })
      .end();
    encoder
      .beginRenderPass({
        colorAttachments: [
          {
            target: surface.getCurrentTarget(),
            load: 'clear',
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
      })
      .end();
    // The top left quarter of the surface.
    encoder.copyTextureToTexture(color, surface.getCurrentTarget(), {
      width: 4,
      height: 4,
    });
    backend().submit([encoder.finish()]);
    const pixels = await surface.readPixels();
    const at = (x: number, y: number) => [
      ...pixels.subarray((y * 8 + x) * 4, (y * 8 + x) * 4 + 4),
    ];
    expect(at(1, 1)).toEqual([0, 0, 255, 255]);
    expect(at(6, 6)).toEqual([0, 0, 0, 255]);
    color.destroy();
    depth.destroy();
    surface.destroy();
  });

  it('copies buffers in the order of the commands', async () => {
    const source = backend().buffers.create({
      size: 16,
      usage: ['copy-src'],
      initialData: new Uint32Array([1, 2, 3, 4]),
    });
    const destination = backend().buffers.create({
      size: 16,
      usage: ['copy-dst'],
    });
    const encoder = backend().createCommandEncoder();
    encoder.copyBufferToBuffer(source, 0, destination, 0, 16);
    // After the first copy: overwrites its last bytes.
    encoder.copyBufferToBuffer(source, 0, destination, 8, 8);
    backend().submit([encoder.finish()]);
    expect([...new Uint32Array(await destination.read())]).toEqual([
      1, 2, 1, 2,
    ]);
    source.destroy();
    destination.destroy();
  });

  it('creates samplers, comparison ones included', () => {
    // Anisotropic filtering needs the linear filters.
    const sampler = backend().textures.createSampler({
      wrapModeS: 'clamp-to-edge',
      maxAnisotropy: 8,
    });
    const shadow = backend().textures.createSampler({ compare: 'less-equal' });
    expect(sampler.id).not.toBe(shadow.id);
    sampler.destroy();
    shadow.destroy();
  });

  it('reports the misuses of the commands', () => {
    const texture = backend().createRenderTarget({
      width: 2,
      height: 2,
      format: 'rgba8unorm',
    });
    texture.destroy();
    const encoder = backend().createCommandEncoder();
    encoder
      .beginRenderPass({
        colorAttachments: [{ target: texture, load: 'clear' }],
      })
      .end();
    expect(() => backend().submit([encoder.finish()])).toThrow(
      /Unknown color target/
    );
  });
});
