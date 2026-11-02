import { beforeAll, describe, expect, it } from 'vitest';
import { compressedFormats, TextureFactory } from './TextureFactory';

// GPUTextureUsage only exists in a WebGPU context.
beforeAll(() => {
  Object.assign(globalThis, {
    GPUTextureUsage: {
      COPY_SRC: 1,
      COPY_DST: 2,
      TEXTURE_BINDING: 4,
      STORAGE_BINDING: 8,
      RENDER_ATTACHMENT: 16,
    },
  });
});

// A fake device recording the textures created, the writes and the
// submissions (the computed levels).
function fakeDevice(features: string[] = []) {
  const log = {
    textures: [] as GPUTextureDescriptor[],
    writes: [] as {
      destination: GPUTexelCopyTextureInfo;
      bytes: number;
      layout: GPUTexelCopyBufferLayout;
      size: number[];
    }[],
    samplers: [] as GPUSamplerDescriptor[],
    submits: 0,
  };
  const device = {
    features: new Set(features),
    createSampler: (descriptor: GPUSamplerDescriptor) => {
      log.samplers.push(descriptor);
      return { label: descriptor.label ?? '' };
    },
    createTexture: (descriptor: GPUTextureDescriptor) => {
      log.textures.push(descriptor);
      return {
        label: descriptor.label ?? '',
        format: descriptor.format,
        mipLevelCount: descriptor.mipLevelCount ?? 1,
        destroy: () => undefined,
      };
    },
    // Records the levels to compute, without encoding them.
    createCommandEncoder: () => ({ finish: () => ({}) }),
    queue: {
      writeTexture: (
        destination: GPUTexelCopyTextureInfo,
        data: ArrayBufferView,
        layout: GPUTexelCopyBufferLayout,
        size: number[],
      ) => {
        log.writes.push({ destination, bytes: data.byteLength, layout, size });
      },
      submit: () => {
        log.submits++;
      },
    },
  };
  const factory = new TextureFactory(device as unknown as GPUDevice);
  // The mipmaps of the fake device: recorded by the submissions.
  factory.mipmaps.encode = () => undefined;
  return { factory, log };
}

describe('TextureFactory', () => {
  it('declares the compressed formats of the features', () => {
    expect(compressedFormats(new Set() as GPUSupportedFeatures)).toEqual([]);
    const formats = compressedFormats(
      new Set([
        'texture-compression-etc2',
        'texture-compression-astc',
      ]) as GPUSupportedFeatures,
    );
    expect(formats).toContain('etc2-rgba8unorm-srgb');
    expect(formats).toContain('eac-rg11unorm');
    expect(formats).toContain('astc-4x4-unorm');
    expect(formats).not.toContain('bc7-rgba-unorm');
  });

  it('writes the levels given, by blocks for the compressed formats', () => {
    const { factory, log } = fakeDevice(['texture-compression-bc']);
    const texture = factory.createTexture({
      type: '2d',
      format: 'bc7-rgba-unorm',
      dimensions: { width: 8, height: 8 },
      levels: [new Uint8Array(64), new Uint8Array(16), new Uint8Array(16)],
    });
    expect(texture.mipLevelCount).toBe(3);
    // Sampled and written only: compressed textures cannot be rendered to.
    expect(log.textures[0].mipLevelCount).toBe(3);
    expect(log.textures[0].usage).toBe(
      GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    );
    expect(log.writes.map((write) => write.destination.mipLevel)).toEqual([
      0, 1, 2,
    ]);
    expect(log.writes[0].layout).toEqual({ bytesPerRow: 32, rowsPerImage: 2 });
    expect(log.writes[0].size).toEqual([8, 8, 1]);
    // A level of 2×2 pixels: a block.
    expect(log.writes[2].layout).toEqual({ bytesPerRow: 16, rowsPerImage: 1 });
    expect(log.writes[2].size).toEqual([4, 4, 1]);
    expect(log.submits).toBe(0);

    // Level 0 rewritten: nothing computed.
    factory.writeTexture(texture, new Uint8Array(64));
    expect(log.writes[3].destination.mipLevel).toBe(0);
    expect(log.submits).toBe(0);
  });

  it('refuses the compressed formats the device does not have', () => {
    const { factory } = fakeDevice(['texture-compression-bc']);
    expect(() =>
      factory.createTexture({
        type: '2d',
        format: 'astc-4x4-unorm',
        dimensions: { width: 4, height: 4 },
      }),
    ).toThrow(/astc-4x4-unorm is not supported by the device/);
  });

  it('writes a level, or a layer of it, without computing the others', () => {
    const { factory, log } = fakeDevice();
    const cube = factory.createTexture({
      type: 'cube',
      format: 'rgba8unorm',
      dimensions: { width: 4, height: 4, layers: 6 },
      mipLevelCount: 3,
    });
    factory.writeTexture(cube, new Uint8Array(4), { level: 2, layer: 4 });
    expect(log.writes[0]).toEqual({
      destination: {
        texture: expect.anything(),
        mipLevel: 2,
        origin: { x: 0, y: 0, z: 4 },
      },
      bytes: 4,
      layout: { bytesPerRow: 4, rowsPerImage: 1 },
      size: [1, 1, 1],
    });
    factory.writeTexture(cube, new Uint8Array(6 * 16), { level: 1 });
    expect(log.writes[1].size).toEqual([2, 2, 6]);
    expect(log.submits).toBe(0);
    expect(() =>
      factory.writeTexture(cube, new Uint8Array(4), { level: 3 }),
    ).toThrow(/no level 3/);

    // Without options: the first level of every layer, the others computed.
    factory.writeTexture(cube, new Uint8Array(6 * 64));
    expect(log.writes[2].destination.mipLevel).toBe(0);
    expect(log.writes[2].size).toEqual([4, 4, 6]);
    expect(log.submits).toBe(1);
  });

  it('creates the 3d textures in 3d, their depth written whole', () => {
    const { factory, log } = fakeDevice();
    factory.createTexture({
      type: '3d',
      format: 'r8unorm',
      dimensions: { width: 4, height: 2, layers: 3 },
      source: new Uint8Array(24),
    });
    factory.createTexture({
      type: '2d-array',
      format: 'r8unorm',
      dimensions: { width: 4, height: 2, layers: 3 },
    });
    expect(log.textures.map((texture) => texture.dimension)).toEqual([
      '3d',
      '2d',
    ]);
    expect(log.textures[0].size).toEqual({
      width: 4,
      height: 2,
      depthOrArrayLayers: 3,
    });
    expect(log.writes[0].size).toEqual([4, 2, 3]);
  });

  it('writes the texels of bgra8unorm', () => {
    const { factory, log } = fakeDevice();
    factory.createTexture({
      type: '2d',
      format: 'bgra8unorm',
      dimensions: { width: 2, height: 2 },
      source: new Uint8Array(16),
    });
    expect(log.writes[0].layout).toEqual({ bytesPerRow: 8, rowsPerImage: 2 });
  });

  it('rejects the data of a format that cannot be written before creating the texture', () => {
    const { factory, log } = fakeDevice();
    expect(() =>
      factory.createTexture({
        type: '2d',
        format: 'depth32float',
        dimensions: { width: 1, height: 1 },
        source: new Uint8Array(4),
      }),
    ).toThrow(/depth32float cannot be written/);
    expect(log.textures).toEqual([]);
    // Without data, the depth textures are created.
    factory.createTexture({
      type: '2d',
      format: 'depth32float',
      dimensions: { width: 1, height: 1 },
      usage: ['render-attachment'],
    });
    expect(log.textures).toHaveLength(1);
  });

  it('labels the samplers', () => {
    const { factory, log } = fakeDevice();
    factory.createSampler({ label: 'shadows', compare: 'less' });
    expect(log.samplers[0]).toMatchObject({
      label: 'shadows',
      compare: 'less',
    });
  });

  it('writes the levels of formats whose levels cannot be computed', () => {
    const { factory, log } = fakeDevice();
    const texture = factory.createTexture({
      type: '2d',
      format: 'r32uint',
      dimensions: { width: 2, height: 2 },
      levels: [new Uint32Array(4), new Uint32Array(1)],
    });
    expect(log.textures[0].usage).toBe(
      GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    );
    expect(log.writes).toHaveLength(2);
    // The first level rewritten: the second one kept.
    factory.writeTexture(texture, new Uint32Array(4));
    expect(log.submits).toBe(0);
  });
});
