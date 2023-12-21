import Gpu from './Gpu';
import MipGenerator from './MipGenerator';

export type CreateTextureOptions = {
  gpu: Gpu;
  size: [number, number];
  label?: string;
  format: GPUTextureFormat;
} & GPUImageCopyExternalImage;

export class TextureLoader {
  private _mipGenerator: MipGenerator;

  constructor() {
    this._mipGenerator = new MipGenerator();
  }

  public async init(gpu: Gpu): Promise<void> {
    return this._mipGenerator.init(gpu);
  }

  public async loadImageBitmap(url: RequestInfo | URL): Promise<ImageBitmap> {
    const res = await fetch(url);
    const blob = await res.blob();
    return await createImageBitmap(blob, { colorSpaceConversion: 'none' });
  }

  public async createTexture({
    gpu,
    source,
    label,
    size,
    format,
  }: CreateTextureOptions): Promise<GPUTexture> {
    const texture = gpu.device.createTexture({
      label,
      format,
      size,
      mipLevelCount: this._mipGenerator.countMipLevels(size[0], size[1]),
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });

    gpu.device.queue.copyExternalImageToTexture(
      { source, flipY: true },
      { texture },
      { width: size[0], height: size[1] }
    );

    if (texture.mipLevelCount) {
      this._mipGenerator.generate(gpu, texture);
    }

    return texture;
  }

  public async loadTexture(
    gpu: Gpu,
    url: RequestInfo | URL
  ): Promise<GPUTexture> {
    const source = await this.loadImageBitmap(url);
    const texture = await this.createTexture({
      gpu,
      source,
      label: url.toString(),
      format: 'rgba8unorm',
      size: [source.width, source.height],
    });

    return texture;
  }
}

export default TextureLoader;
