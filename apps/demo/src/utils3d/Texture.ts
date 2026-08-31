export class Texture {
  name: string;
  width: number;
  height: number;
  depthOrArrayLayers: number;
  format: GPUTextureFormat;
  texture: GPUTexture;
  sampler: GPUSampler;
  stage: GPUShaderStageFlags;

  constructor(options: {
    name: string;
    width: number;
    height: number;
    depthOrArrayLayers?: number;
    format: GPUTextureFormat;
    device: GPUDevice;
    imageBitmap: ImageBitmap;
    samplerDescriptor: GPUSamplerDescriptor;
    stage?: GPUShaderStageFlags;
  }) {
    this.name = options.name;
    this.width = options.width;
    this.height = options.height;
    this.format = options.format;
    this.depthOrArrayLayers = options.depthOrArrayLayers ?? 1;
    this.sampler = options.device.createSampler(options.samplerDescriptor);
    this.stage = options.stage ?? GPUShaderStage.FRAGMENT;

    this.texture = options.device.createTexture({
      size: {
        width: this.width,
        height: this.height,
        depthOrArrayLayers: this.depthOrArrayLayers,
      },
      format: this.format,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    options.device.queue.copyExternalImageToTexture(
      { source: options.imageBitmap },
      { texture: this.texture },
      {
        width: this.width,
        height: this.height,
        depthOrArrayLayers: this.depthOrArrayLayers,
      }
    );
  }
}
