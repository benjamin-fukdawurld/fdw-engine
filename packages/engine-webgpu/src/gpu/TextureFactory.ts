import {
  canGenerateMipmaps,
  checkMipLevelCount,
  samplerAnisotropy,
  GpuSampler,
  GpuSamplerFactory,
  GpuSamplerConfiguration,
  GpuTexture,
  GpuTextureConfiguration,
  GpuTextureFactory,
  GpuTextureFormatName,
  GpuTextureFormatNames,
  GpuTextureUsage,
} from '@fdw/engine-backend';
import { Texture } from './Texture';
import { Sampler } from './Sampler';
import { MipmapGenerator } from './MipmapGenerator';

function textureUsageFlags(usage: readonly GpuTextureUsage[]): number {
  const flags: Record<GpuTextureUsage, number> = {
    sampled: GPUTextureUsage.TEXTURE_BINDING,
    storage: GPUTextureUsage.STORAGE_BINDING,
    'render-attachment': GPUTextureUsage.RENDER_ATTACHMENT,
    'copy-src': GPUTextureUsage.COPY_SRC,
    'copy-dst': GPUTextureUsage.COPY_DST,
  };
  return usage.reduce((all, name) => all | flags[name], 0);
}

// ImageBitmap only exists in browsers: guard the check for other runtimes.
const isImageBitmap = (source: unknown): source is ImageBitmap =>
  typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap;

// WebGPU accepts any anisotropy and clamps it to what the device can do:
// 16 at most on the current GPUs.
export const MaxAnisotropy = 16;

export class TextureFactory
  implements GpuTextureFactory<ImageBitmap>, GpuSamplerFactory
{
  public readonly device: GPUDevice;
  readonly mipmaps: MipmapGenerator;
  defaultMaxAnisotropy = 1;

  constructor(device: GPUDevice) {
    this.device = device;
    this.mipmaps = new MipmapGenerator(device);
  }

  createTexture(
    descriptor: GpuTextureConfiguration & {
      source?: ImageBitmap | ArrayBufferView<ArrayBuffer>;
      readwrite?: boolean;
    }
  ): GpuTexture {
    const {
      type,
      format,
      dimensions,
      source,
      readwrite,
      label,
      usage,
      sampleCount = 1,
    } = descriptor;
    const { width, height = 1, layers = 1 } = dimensions;
    const mipLevelCount = checkMipLevelCount(descriptor);

    const textureDescriptor: GPUTextureDescriptor = {
      size: {
        width,
        height,
        depthOrArrayLayers: layers,
      },
      format: TextureFactory.textureFormatToGPUTextureFormat(format),
      sampleCount,
      mipLevelCount,
      usage:
        (usage
          ? textureUsageFlags(usage)
          : GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST) |
        // Uploads need these.
        (source ? GPUTextureUsage.COPY_DST : 0) |
        (readwrite || isImageBitmap(source)
          ? GPUTextureUsage.RENDER_ATTACHMENT
          : 0) |
        // The levels are rendered from the previous ones.
        (mipLevelCount > 1
          ? GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
          : 0),
      label,
    };

    const texture = this.device.createTexture(textureDescriptor);

    if (source) {
      if (isImageBitmap(source)) {
        this.device.queue.copyExternalImageToTexture({ source }, { texture }, [
          width,
          height,
        ]);
      } else if (ArrayBuffer.isView(source)) {
        this.device.queue.writeTexture(
          { texture },
          source,
          {
            bytesPerRow:
              width * TextureFactory.textureFormatToBytesPerPixel(format),
          },
          [width, height]
        );
      } else {
        throw new Error(`Unsupported source type: ${source}`);
      }
      this.generateMipmaps(texture);
    }

    return new Texture({
      type,
      format,
      dimensions,
      texture,
      sampleCount,
      mipLevelCount,
    });
  }

  /**
   * Records the computation of the levels of a texture after the first one
   * (see GpuCommandEncoder.generateMipmaps).
   */
  encodeMipmaps(encoder: GPUCommandEncoder, texture: GPUTexture): void {
    if (texture.mipLevelCount === 1) {
      return;
    }
    if (!canGenerateMipmaps(texture.format)) {
      throw new Error(
        `The levels of texture "${texture.label}" (${texture.format}) cannot be computed`
      );
    }
    this.mipmaps.encode(encoder, texture);
  }

  // Computes the levels of an uploaded texture, in the order of the queue.
  private generateMipmaps(texture: GPUTexture): void {
    if (texture.mipLevelCount === 1) {
      return;
    }
    const encoder = this.device.createCommandEncoder();
    this.encodeMipmaps(encoder, texture);
    this.device.queue.submit([encoder.finish()]);
  }

  writeTexture(texture: GpuTexture, data: ArrayBufferView<ArrayBuffer>): void {
    const target = (texture as Texture).texture;
    if (!target) {
      throw new Error('Cannot write a destroyed texture');
    }
    const { width, height = 1, layers = 1 } = texture.dimensions;
    this.device.queue.writeTexture(
      { texture: target },
      data,
      {
        bytesPerRow:
          width * TextureFactory.textureFormatToBytesPerPixel(texture.format),
        rowsPerImage: height,
      },
      [width, height, layers]
    );
    this.generateMipmaps(target);
  }

  createSampler(descriptor?: GpuSamplerConfiguration): GpuSampler {
    const samplerDescriptor: GPUSamplerDescriptor = {
      addressModeU: (descriptor?.wrapModeS ?? 'repeat') as GPUAddressMode,
      addressModeV: (descriptor?.wrapModeT ?? 'repeat') as GPUAddressMode,
      addressModeW: (descriptor?.wrapModeR ?? 'repeat') as GPUAddressMode,
      magFilter: (descriptor?.magFilter ?? 'linear') as GPUFilterMode,
      minFilter: (descriptor?.minFilter ?? 'linear') as GPUFilterMode,
      mipmapFilter: (descriptor?.mipmapFilter ?? 'linear') as GPUFilterMode,
      maxAnisotropy: samplerAnisotropy(
        descriptor ?? {},
        this.defaultMaxAnisotropy,
        MaxAnisotropy
      ),
      ...(descriptor?.compare ? { compare: descriptor.compare } : {}),
    };

    return new Sampler({
      ...descriptor,
      maxAnisotropy: samplerDescriptor.maxAnisotropy,
      sampler: this.device.createSampler(samplerDescriptor),
    });
  }

  private static textureFormatToGPUTextureFormat(
    format: string
  ): GPUTextureFormat {
    if (GpuTextureFormatNames.includes(format as GpuTextureFormatName)) {
      return format as GPUTextureFormat;
    }

    throw new Error(`Unsupported texture format: ${format}`);
  }

  private static textureFormatToBytesPerPixel(format: string): number {
    switch (format) {
      case 'r8unorm':
      case 'r8snorm':
      case 'r8uint':
      case 'r8sint':
        return 1;
      case 'rg8unorm':
      case 'rg8snorm':
      case 'rg8uint':
      case 'rg8sint':
        return 2;
      case 'rgba8unorm':
      case 'rgba8unorm-srgb':
      case 'rgba8snorm':
      case 'rgba8uint':
      case 'rgba8sint':
      case 'r32float':
      case 'r32uint':
      case 'r32sint':
      case 'rg16float':
      case 'rg16uint':
      case 'rg16sint':
      case 'rgb10a2unorm':
        return 4;
      case 'r16float':
      case 'r16uint':
      case 'r16sint':
        return 2;
      case 'rgba16float':
      case 'rgba16uint':
      case 'rgba16sint':
      case 'rg32float':
      case 'rg32uint':
      case 'rg32sint':
        return 8;
      case 'rgba32float':
      case 'rgba32uint':
      case 'rgba32sint':
        return 16;

      default:
        throw new Error(`Unsupported texture format: ${format}`);
    }
  }
}
