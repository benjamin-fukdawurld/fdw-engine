import {
  checkMipLevelCount,
  checkReadRegion,
  samplerAnisotropy,
} from '@fdw/engine-backend';
import type {
  GpuRenderTarget,
  GpuSampler,
  GpuSamplerConfiguration,
  GpuSamplerFactory,
  GpuTexture,
  GpuTextureConfiguration,
  GpuTextureDimensions,
  GpuTextureFactory,
  GpuTextureFormat,
  GpuTextureRegion,
  GpuTextureType,
  GpuTextureUsage,
} from '@fdw/engine-backend';
import {
  ContextHandle,
  SamplerHandle,
  TextureHandle,
  TextureUsageFlags,
  VulkanAddon,
} from '../addon';

// Resolves on the next turn of the event loop: polls the GPU without
// blocking Node.
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * A texture in GPU memory, or a render target (a texture with the
 * render-attachment usage). Its id identifies it in the commands.
 */
export class VulkanTexture implements GpuTexture, GpuRenderTarget {
  readonly id: number;
  private _handle?: TextureHandle;

  constructor(
    private readonly _addon: VulkanAddon,
    private readonly _context: ContextHandle,
    readonly type: GpuTextureType,
    readonly format: GpuTextureFormat,
    readonly dimensions: GpuTextureDimensions,
    readonly usage: readonly GpuTextureUsage[],
    readonly sampleCount = 1,
    readonly mipLevelCount = 1,
    readonly label?: string,
    // An image owned by the native side (a swapchain image): wrapped, not
    // created.
    existing?: TextureHandle
  ) {
    this._handle =
      existing ??
      _addon.createTexture(
        _context,
        format,
        type,
        dimensions.width,
        dimensions.height ?? 1,
        dimensions.layers ?? 1,
        sampleCount,
        mipLevelCount,
        usage.reduce((flags, name) => flags | TextureUsageFlags[name], 0),
        label
      );
    this.id = _addon.textureId(this._handle);
  }

  get width(): number {
    return this.dimensions.width;
  }

  get height(): number {
    return this.dimensions.height ?? 1;
  }

  get handle(): TextureHandle {
    if (!this._handle) {
      throw new Error(`Texture "${this.label ?? '(unlabeled)'}" was destroyed`);
    }
    return this._handle;
  }

  /**
   * Writes the first level of every layer, rows from the top, tightly
   * packed, then computes the other levels.
   */
  write(data: ArrayBufferView): void {
    this._addon.writeTexture(this.handle, data);
    if (this.mipLevelCount > 1) {
      this._addon.generateMipmaps(this.handle);
    }
  }

  /**
   * Reads a region of the first layer back (the whole layer by default),
   * rows from the top, tightly packed: after every command submitted
   * before.
   */
  read(region?: GpuTextureRegion): Promise<ArrayBuffer> {
    // Checked before reading: a wrong region throws, as on the other
    // backends.
    const checked = checkReadRegion(this, region);
    const { x, y, width, height } = checked.region;
    const ticket = this._addon.readTexture(this.handle, x, y, width, height);
    return this.take(ticket, width * height * checked.bytesPerPixel);
  }

  private async take(ticket: number, size: number): Promise<ArrayBuffer> {
    while (!this._addon.readReady(this._context, ticket)) {
      await nextTurn();
    }
    const data = new ArrayBuffer(size);
    this._addon.readTake(this._context, ticket, new Uint8Array(data));
    return data;
  }

  destroy(): void {
    if (this._handle) {
      // Freed once the GPU no longer uses it.
      this._addon.destroyTexture(this._handle);
      this._handle = undefined;
    }
  }
}

export class VulkanSampler implements GpuSampler {
  readonly id: number;
  readonly wrapModeS?: string;
  readonly wrapModeT?: string;
  readonly wrapModeR?: string;
  readonly minFilter?: string;
  readonly magFilter?: string;
  readonly mipmapFilter?: string;
  readonly maxAnisotropy?: number;
  readonly compare?: GpuSamplerConfiguration['compare'];
  readonly label?: string;
  private _handle?: SamplerHandle;

  constructor(
    private readonly _addon: VulkanAddon,
    context: ContextHandle,
    config: GpuSamplerConfiguration = {},
    defaultMaxAnisotropy = 1
  ) {
    this.wrapModeS = config.wrapModeS ?? 'repeat';
    this.wrapModeT = config.wrapModeT ?? 'repeat';
    this.wrapModeR = config.wrapModeR ?? 'repeat';
    this.minFilter = config.minFilter ?? 'linear';
    this.magFilter = config.magFilter ?? 'linear';
    this.mipmapFilter = config.mipmapFilter ?? 'linear';
    this.maxAnisotropy = samplerAnisotropy(
      config,
      defaultMaxAnisotropy,
      _addon.maxAnisotropy(context)
    );
    this.compare = config.compare;
    this.label = config.label;
    this._handle = _addon.createSampler(
      context,
      this.minFilter,
      this.magFilter,
      this.mipmapFilter,
      this.wrapModeS,
      this.wrapModeT,
      this.wrapModeR,
      this.maxAnisotropy,
      this.compare,
      this.label
    );
    this.id = _addon.samplerId(this._handle);
  }

  destroy(): void {
    if (this._handle) {
      this._addon.destroySampler(this._handle);
      this._handle = undefined;
    }
  }
}

export class VulkanTextureFactory
  implements GpuTextureFactory<never>, GpuSamplerFactory
{
  defaultMaxAnisotropy = 1;

  constructor(
    private readonly _addon: VulkanAddon,
    private readonly _context: ContextHandle
  ) {}

  createTexture(
    descriptor: GpuTextureConfiguration & {
      source?: ArrayBufferView<ArrayBuffer>;
      readwrite?: boolean;
    }
  ): VulkanTexture {
    const { type, format, dimensions, label, source, readwrite } = descriptor;
    const usage: GpuTextureUsage[] = [
      ...(descriptor.usage ?? ['sampled', 'copy-dst']),
      ...(readwrite ? (['render-attachment'] as const) : []),
    ];
    const texture = new VulkanTexture(
      this._addon,
      this._context,
      type,
      format,
      dimensions,
      usage,
      descriptor.sampleCount ?? 1,
      checkMipLevelCount(descriptor),
      label
    );
    if (source) {
      texture.write(source);
    }
    return texture;
  }

  writeTexture(texture: GpuTexture, data: ArrayBufferView<ArrayBuffer>): void {
    (texture as VulkanTexture).write(data);
  }

  readTexture(
    texture: GpuTexture,
    region?: GpuTextureRegion
  ): Promise<ArrayBuffer> {
    return (texture as VulkanTexture).read(region);
  }

  createSampler(descriptor?: GpuSamplerConfiguration): VulkanSampler {
    return new VulkanSampler(
      this._addon,
      this._context,
      descriptor,
      this.defaultMaxAnisotropy
    );
  }
}
