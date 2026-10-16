import { describe, expect, it } from 'vitest';
import { samplerAnisotropy } from './GpuSampler';
import {
  canGenerateMipmaps,
  checkMipLevelCount,
  checkReadRegion,
  checkTextureContent,
  checkTextureWrite,
  compressedBlock,
  fullMipLevelCount,
  GpuTexture,
  isCompressedFormat,
  levelDimensions,
  textureLevelSize,
} from './GpuTexture';

describe('mipmaps', () => {
  it('counts the levels down to 1×1', () => {
    expect(fullMipLevelCount({ width: 1 })).toBe(1);
    expect(fullMipLevelCount({ width: 4, height: 4 })).toBe(3);
    // The largest side: 256 × 64 → 128 × 32 → … → 1 × 1.
    expect(fullMipLevelCount({ width: 256, height: 64 })).toBe(9);
    expect(fullMipLevelCount({ width: 5, height: 3 })).toBe(3);
  });

  it('computes the levels of the color formats only', () => {
    expect(canGenerateMipmaps('rgba8unorm-srgb')).toBe(true);
    expect(canGenerateMipmaps('rgba16float')).toBe(true);
    expect(canGenerateMipmaps('r32uint')).toBe(false);
    expect(canGenerateMipmaps('rgba8sint')).toBe(false);
    expect(canGenerateMipmaps('depth24plus')).toBe(false);
    expect(canGenerateMipmaps('bc7-rgba-unorm')).toBe(false);
    expect(canGenerateMipmaps('etc2-rgb8unorm-srgb')).toBe(false);
  });

  it('accepts the levels of any format when they are given', () => {
    const dimensions = { width: 4, height: 4 };
    expect(
      checkMipLevelCount(
        { type: '2d', format: 'rgba8uint', dimensions, mipLevelCount: 3 },
        { provided: true }
      )
    ).toBe(3);
    // Those of the compressed formats are always written.
    expect(
      checkMipLevelCount({
        type: '2d',
        format: 'bc7-rgba-unorm',
        dimensions,
        mipLevelCount: 3,
      })
    ).toBe(3);
  });

  it('refuses the levels a texture cannot have', () => {
    const texture = { type: '2d', format: 'rgba8unorm' } as const;
    const dimensions = { width: 4, height: 4 };
    expect(checkMipLevelCount({ ...texture, dimensions })).toBe(1);
    expect(
      checkMipLevelCount({ ...texture, dimensions, mipLevelCount: 3 })
    ).toBe(3);
    expect(() =>
      checkMipLevelCount({ ...texture, dimensions, mipLevelCount: 0 })
    ).toThrow(/invalid mipLevelCount/);
    expect(() =>
      checkMipLevelCount({ ...texture, dimensions, mipLevelCount: 4 })
    ).toThrow(/more than the 3 of its size/);
    expect(() =>
      checkMipLevelCount({
        ...texture,
        dimensions,
        mipLevelCount: 2,
        sampleCount: 4,
      })
    ).toThrow(/multisampled/);
    expect(() =>
      checkMipLevelCount({
        type: '3d',
        format: 'rgba8unorm',
        dimensions,
        mipLevelCount: 2,
      })
    ).toThrow(/3d textures/);
    expect(() =>
      checkMipLevelCount({
        type: '2d',
        format: 'rgba8uint',
        dimensions,
        mipLevelCount: 2,
      })
    ).toThrow(/cannot be computed/);
  });
});

describe('compressed formats', () => {
  it('stores the pixels by blocks', () => {
    expect(compressedBlock('bc1-rgba-unorm')).toEqual({
      width: 4,
      height: 4,
      bytes: 8,
    });
    expect(compressedBlock('bc7-rgba-unorm-srgb')?.bytes).toBe(16);
    expect(compressedBlock('eac-r11unorm')?.bytes).toBe(8);
    expect(compressedBlock('astc-4x4-unorm')?.bytes).toBe(16);
    expect(compressedBlock('rgba8unorm')).toBeUndefined();
    expect(compressedBlock('toString')).toBeUndefined();
    expect(isCompressedFormat('etc2-rgba8unorm')).toBe(true);
    expect(isCompressedFormat('depth24plus')).toBe(false);
  });

  it('measures the levels', () => {
    const dimensions = { width: 8, height: 2 };
    expect(levelDimensions(dimensions, 0)).toEqual({ width: 8, height: 2 });
    expect(levelDimensions(dimensions, 2)).toEqual({ width: 2, height: 1 });
    expect(levelDimensions({ width: 1 }, 3)).toEqual({ width: 1, height: 1 });
    expect(textureLevelSize('rgba8unorm', dimensions, 0)).toBe(64);
    expect(textureLevelSize('rgba16float', dimensions, 1)).toBe(32);
    // Rows of blocks: the blocks of the edges partly outside.
    expect(textureLevelSize('bc7-rgba-unorm', dimensions, 0)).toBe(32);
    expect(textureLevelSize('bc7-rgba-unorm', dimensions, 3)).toBe(16);
    expect(
      textureLevelSize('bc1-rgba-unorm', { width: 10, height: 6 }, 0)
    ).toBe(3 * 2 * 8);
    expect(() => textureLevelSize('depth24plus', dimensions, 0)).toThrow(
      /cannot be written/
    );
  });

  it('cannot be read back', () => {
    const texture: GpuTexture = {
      type: '2d',
      format: 'bc7-rgba-unorm',
      dimensions: { width: 4, height: 4 },
      usage: ['copy-src'],
      destroy: () => undefined,
    };
    expect(() => checkReadRegion(texture)).toThrow(/cannot be read back/);
  });
});

describe('texture writes', () => {
  const cube: GpuTexture = {
    type: 'cube',
    format: 'rgba8unorm',
    dimensions: { width: 4, height: 4, layers: 6 },
    mipLevelCount: 3,
    destroy: () => undefined,
  };

  it('writes a level of every layer, or of one', () => {
    expect(
      checkTextureWrite(cube, new Uint8Array(6 * 16), { level: 1 })
    ).toEqual({ level: 1, layer: 0, layers: 6 });
    expect(
      checkTextureWrite(cube, new Uint8Array(4), { level: 2, layer: 5 })
    ).toEqual({ level: 2, layer: 5, layers: 1 });
    expect(checkTextureWrite(cube, new Uint8Array(64), { layer: 3 })).toEqual({
      level: 0,
      layer: 3,
      layers: 1,
    });
  });

  it('refuses the levels, layers and sizes the texture does not have', () => {
    expect(() =>
      checkTextureWrite(cube, new Uint8Array(4), { level: 3 })
    ).toThrow(/no level 3 \(it has 3\)/);
    expect(() =>
      checkTextureWrite(cube, new Uint8Array(4), { level: 2, layer: 6 })
    ).toThrow(/no layer 6 \(it has 6\)/);
    expect(() =>
      checkTextureWrite(cube, new Uint8Array(16), { level: 1 })
    ).toThrow(/level 1 takes 96 bytes, not 16/);
    expect(() =>
      checkTextureWrite(
        { ...cube, type: '3d', mipLevelCount: 1 },
        new Uint8Array(64),
        { layer: 1 }
      )
    ).toThrow(/3d textures are written whole/);
  });

  it('checks the content of a new texture', () => {
    const texture = {
      type: '2d',
      format: 'bc7-rgba-unorm',
      dimensions: { width: 8, height: 8 },
    } as const;
    const levels = [new Uint8Array(64), new Uint8Array(16)];
    // As many levels as given by default.
    expect(checkTextureContent({ ...texture, levels })).toBe(2);
    expect(checkTextureContent({ ...texture, levels, mipLevelCount: 4 })).toBe(
      4
    );
    expect(checkTextureContent({ ...texture })).toBe(1);
    expect(
      checkTextureContent({ ...texture, source: new Uint8Array(64) })
    ).toBe(1);
    expect(() =>
      checkTextureContent({ ...texture, levels, mipLevelCount: 1 })
    ).toThrow(/2 levels given, for 1/);
    expect(() => checkTextureContent({ ...texture, levels: [] })).toThrow(
      /no levels given/
    );
    expect(() =>
      checkTextureContent({
        ...texture,
        levels: [new Uint8Array(64), new Uint8Array(64)],
      })
    ).toThrow(/level 1 takes 16 bytes, not 64/);
    expect(() =>
      checkTextureContent({
        ...texture,
        levels,
        source: new Uint8Array(64),
      })
    ).toThrow(/a source or levels, not both/);
    expect(() => checkTextureContent({ ...texture, source: {} })).toThrow(
      /written from bytes only/
    );
    // The levels of the other formats are computed without them.
    expect(() =>
      checkTextureContent({
        type: '2d',
        format: 'r32uint',
        dimensions: { width: 2, height: 2 },
        mipLevelCount: 2,
      })
    ).toThrow(/cannot be computed/);
    expect(
      checkTextureContent({
        type: '2d',
        format: 'r32uint',
        dimensions: { width: 2, height: 2 },
        levels: [new Uint8Array(16), new Uint8Array(4)],
      })
    ).toBe(2);
  });
});

describe('samplerAnisotropy', () => {
  it('keeps the anisotropy asked, within the limit of the device', () => {
    expect(samplerAnisotropy({ maxAnisotropy: 4 }, 1, 16)).toBe(4);
    expect(samplerAnisotropy({ maxAnisotropy: 64 }, 1, 16)).toBe(16);
    expect(samplerAnisotropy({ maxAnisotropy: 8 }, 1, 1)).toBe(1);
    expect(() => samplerAnisotropy({ maxAnisotropy: 0 }, 1, 16)).toThrow(
      /invalid maxAnisotropy/
    );
  });

  it('applies the default to the linear samplers only', () => {
    expect(samplerAnisotropy({}, 8, 16)).toBe(8);
    expect(samplerAnisotropy({}, 8, 4)).toBe(4);
    expect(samplerAnisotropy({ mipmapFilter: 'nearest' }, 8, 16)).toBe(1);
    expect(samplerAnisotropy({ compare: 'less-equal' }, 8, 16)).toBe(1);
    // Asked explicitly: 1 stays 1.
    expect(samplerAnisotropy({ maxAnisotropy: 1 }, 8, 16)).toBe(1);
  });

  it('refuses anisotropy with a nearest filter, as WebGPU', () => {
    expect(() =>
      samplerAnisotropy({ maxAnisotropy: 4, minFilter: 'nearest' }, 1, 16)
    ).toThrow(/needs linear min, mag and mipmap filters/);
    expect(
      samplerAnisotropy({ maxAnisotropy: 1, minFilter: 'nearest' }, 1, 16)
    ).toBe(1);
  });
});
