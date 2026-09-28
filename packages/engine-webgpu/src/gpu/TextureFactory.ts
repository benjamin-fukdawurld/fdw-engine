import {
  GpuSampler,
  GpuSamplerFactory,
  GpuSamplerConfiguration,
  GpuTexture,
  GpuTextureConfiguration,
  GpuTextureFactory,
  GpuTextureFormatName,
  GpuTextureFormatNames,
} from '@fdw/engine-backend';
import { Texture } from './Texture';
import { Sampler } from './Sampler';

export class TextureFactory implements GpuTextureFactory, GpuSamplerFactory {
  public readonly device: GPUDevice;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  createTexture(
    descriptor: GpuTextureConfiguration & {
      source?: ArrayBufferView<ArrayBuffer> | unknown;
      readwrite?: boolean;
    }
  ): GpuTexture {
    const { type, format, dimensions, source, readwrite, label } = descriptor;
    const { width, height = 1, layers = 1 } = dimensions;

    const textureDescriptor: GPUTextureDescriptor = {
      size: {
        width,
        height,
        depthOrArrayLayers: layers,
      },
      format: TextureFactory.textureFormatToGPUTextureFormat(format),
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        (readwrite || source instanceof ImageBitmap
          ? GPUTextureUsage.RENDER_ATTACHMENT
          : 0),
      label,
    };

    const texture = this.device.createTexture(textureDescriptor);

    if (source) {
      if (source instanceof ImageBitmap) {
        this.device.queue.copyExternalImageToTexture({ source }, { texture }, [
          width,
          height,
        ]);
      } else if (source instanceof ArrayBuffer) {
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
    }

    return new Texture({
      type,
      format,
      dimensions,
      texture,
    });
  }

  createSampler(descriptor?: GpuSamplerConfiguration): GpuSampler {
    const samplerDescriptor: GPUSamplerDescriptor = {
      addressModeU: (descriptor?.wrapModeS ?? 'repeat') as GPUAddressMode,
      addressModeV: (descriptor?.wrapModeT ?? 'repeat') as GPUAddressMode,
      addressModeW: (descriptor?.wrapModeR ?? 'repeat') as GPUAddressMode,
      magFilter: (descriptor?.magFilter ?? 'linear') as GPUFilterMode,
      minFilter: (descriptor?.minFilter ?? 'linear') as GPUFilterMode,
      mipmapFilter: (descriptor?.mipmapFilter ?? 'linear') as GPUFilterMode,
      maxAnisotropy: descriptor?.maxAnisotropy ?? 1,
    };

    return new Sampler({
      ...descriptor,
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
        return 4;

      default:
        throw new Error(`Unsupported texture format: ${format}`);
    }
  }
}
