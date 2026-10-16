import {
  canGenerateMipmaps,
  checkReadRegion,
  checkTextureContent,
  checkTextureWrite,
  compressedBlock,
  isCompressedFormat,
  levelDimensions,
  samplerAnisotropy,
  GpuSampler,
  GpuSamplerFactory,
  GpuSamplerConfiguration,
  GpuTexture,
  GpuTextureConfiguration,
  GpuTextureDimensions,
  GpuTextureFactory,
  GpuTextureFormat,
  GpuTextureFormatName,
  GpuTextureFormatNames,
  GpuTextureRegion,
  GpuTextureUsage,
  GpuTextureWriteOptions,
} from '@fdw/engine-backend';
import { Texture } from './Texture';
import { Sampler } from './Sampler';
import { MipmapGenerator } from './MipmapGenerator';
import { readTextureRegion } from './readback';

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

// The compressed formats of each optional feature of WebGPU (WebGpuEngine
// asks for those the adapter has).
export const CompressionFeatures: Readonly<
  Record<string, readonly GpuTextureFormatName[]>
> = {
  'texture-compression-bc': [
    'bc1-rgba-unorm',
    'bc1-rgba-unorm-srgb',
    'bc3-rgba-unorm',
    'bc3-rgba-unorm-srgb',
    'bc4-r-unorm',
    'bc5-rg-unorm',
    'bc6h-rgb-ufloat',
    'bc7-rgba-unorm',
    'bc7-rgba-unorm-srgb',
  ],
  'texture-compression-etc2': [
    'etc2-rgb8unorm',
    'etc2-rgb8unorm-srgb',
    'etc2-rgba8unorm',
    'etc2-rgba8unorm-srgb',
    'eac-r11unorm',
    'eac-rg11unorm',
  ],
  'texture-compression-astc': ['astc-4x4-unorm', 'astc-4x4-unorm-srgb'],
};

/** The compressed formats of the features of a device. */
export const compressedFormats = (
  features: GPUSupportedFeatures,
): GpuTextureFormatName[] =>
  Object.entries(CompressionFeatures).flatMap(([feature, formats]) =>
    features.has(feature) ? formats : [],
  );

// WebGPU accepts any anisotropy and clamps it to what the device can do:
// 16 at most on the current GPUs.
export const MaxAnisotropy = 16;

export class TextureFactory
  implements GpuTextureFactory<ImageBitmap>, GpuSamplerFactory
{
  public readonly device: GPUDevice;
  readonly mipmaps: MipmapGenerator;
  // The compressed formats of the device (see compressedFormats).
  readonly compressedFormats: readonly GpuTextureFormat[];
  defaultMaxAnisotropy = 1;

  constructor(device: GPUDevice) {
    this.device = device;
    this.mipmaps = new MipmapGenerator(device);
    this.compressedFormats = compressedFormats(device.features);
  }

  createTexture(
    descriptor: GpuTextureConfiguration & {
      source?: ImageBitmap | ArrayBufferView<ArrayBuffer>;
      levels?: readonly ArrayBufferView<ArrayBuffer>[];
      readwrite?: boolean;
    },
  ): GpuTexture {
    const {
      type,
      format,
      dimensions,
      source,
      levels,
      readwrite,
      label,
      usage,
      sampleCount = 1,
    } = descriptor;
    const { width, height = 1, layers = 1 } = dimensions;
    const mipLevelCount = checkTextureContent(descriptor);
    // A clear error rather than a validation one.
    if (
      isCompressedFormat(format) &&
      !this.compressedFormats.includes(format)
    ) {
      throw new Error(
        `Texture format ${format} is not supported by the device`,
      );
    }

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
        (source || levels ? GPUTextureUsage.COPY_DST : 0) |
        (readwrite || isImageBitmap(source)
          ? GPUTextureUsage.RENDER_ATTACHMENT
          : 0) |
        // The levels are rendered from the previous ones, where they can be
        // computed (the compressed formats cannot be rendered to).
        (mipLevelCount > 1 && canGenerateMipmaps(format)
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
        // Every layer: the six faces of a cube, the layers of an array.
        this.writeLevel(texture, format, dimensions, source, 0, 0, layers);
      } else {
        throw new Error(`Unsupported source type: ${source}`);
      }
      this.generateMipmaps(texture);
    }
    // Written as they are, every layer of each.
    levels?.forEach((data, level) =>
      this.writeLevel(texture, format, dimensions, data, level, 0, layers),
    );

    return new Texture({
      type,
      format,
      dimensions,
      texture,
      sampleCount,
      mipLevelCount,
      ...(usage ? { usage } : {}),
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
        `The levels of texture "${texture.label}" (${texture.format}) cannot be computed`,
      );
    }
    this.mipmaps.encode(encoder, texture);
  }

  // Computes the levels of an uploaded texture, in the order of the queue,
  // where they can be (the others are written).
  private generateMipmaps(texture: GPUTexture): void {
    if (texture.mipLevelCount === 1 || !canGenerateMipmaps(texture.format)) {
      return;
    }
    const encoder = this.device.createCommandEncoder();
    this.encodeMipmaps(encoder, texture);
    this.device.queue.submit([encoder.finish()]);
  }

  writeTexture(
    texture: GpuTexture,
    data: ArrayBufferView<ArrayBuffer>,
    options?: GpuTextureWriteOptions,
  ): void {
    const target = (texture as Texture).texture;
    if (!target) {
      throw new Error('Cannot write a destroyed texture');
    }
    const { format, dimensions } = texture;
    if (options?.level === undefined && options?.layer === undefined) {
      const { layers = 1 } = dimensions;
      this.writeLevel(target, format, dimensions, data, 0, 0, layers);
      this.generateMipmaps(target);
      return;
    }
    const { level, layer, layers } = checkTextureWrite(texture, data, options);
    this.writeLevel(target, format, dimensions, data, level, layer, layers);
  }

  // Writes the layers [layer, layer + layers) of a level (the depth of a 3d
  // texture): rows of texels, or of blocks, tightly packed.
  private writeLevel(
    texture: GPUTexture,
    format: GpuTextureFormat,
    dimensions: GpuTextureDimensions,
    data: ArrayBufferView<ArrayBuffer>,
    level: number,
    layer: number,
    layers: number,
  ): void {
    const { width, height } = levelDimensions(dimensions, level);
    const block = compressedBlock(format) ?? {
      width: 1,
      height: 1,
      bytes: TextureFactory.textureFormatToBytesPerPixel(format),
    };
    const columns = Math.ceil(width / block.width);
    const rows = Math.ceil(height / block.height);
    this.device.queue.writeTexture(
      { texture, mipLevel: level, origin: { x: 0, y: 0, z: layer } },
      data,
      // Rows of blocks for the compressed formats.
      { bytesPerRow: columns * block.bytes, rowsPerImage: rows },
      // Whole blocks: a level of 2×2 pixels is written as a block of 4×4.
      [columns * block.width, rows * block.height, layers],
    );
  }

  readTexture(
    texture: GpuTexture,
    region?: GpuTextureRegion,
  ): Promise<ArrayBuffer> {
    const checked = checkReadRegion(texture, region);
    const source = (texture as Texture).texture;
    if (!source) {
      throw new Error('Cannot read a destroyed texture');
    }
    return readTextureRegion(
      this.device,
      source,
      checked.region,
      checked.bytesPerPixel,
    );
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
        MaxAnisotropy,
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
    format: string,
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
