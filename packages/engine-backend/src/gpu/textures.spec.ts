import { describe, expect, it } from 'vitest';
import { samplerAnisotropy } from './GpuSampler';
import {
  canGenerateMipmaps,
  checkMipLevelCount,
  fullMipLevelCount,
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
