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

  /** Writes every layer: rows from the top, tightly packed. */
  write(data: ArrayBufferView): void {
    this._addon.writeTexture(this.handle, data);
  }

  /**
   * Reads the pixels of the first layer back, rows from the top, tightly
   * packed: after every command submitted before.
   */
  async read(): Promise<ArrayBuffer> {
    const ticket = this._addon.readTexture(this.handle);
    while (!this._addon.readReady(this._context, ticket)) {
      await nextTurn();
    }
    // The size is known by the addon: width × height × bytes per pixel.
    const data = new ArrayBuffer(
      this.width * this.height * pixelSize(this.format)
    );
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

// Bytes per pixel of the formats, as in the native library.
const pixelSizes: Record<string, number> = {
  r8unorm: 1,
  r8uint: 1,
  r8sint: 1,
  rg8unorm: 2,
  rg8uint: 2,
  rg8sint: 2,
  r16float: 2,
  r16uint: 2,
  r16sint: 2,
  depth16unorm: 2,
  rgba16float: 8,
  rgba16uint: 8,
  rgba16sint: 8,
  rg32float: 8,
  rg32uint: 8,
  rg32sint: 8,
  'depth24plus-stencil8': 8,
  rgba32float: 16,
  rgba32uint: 16,
  rgba32sint: 16,
};

/** Bytes per pixel of a format: 4 for the others (rgba8unorm, r32float…). */
export const pixelSize = (format: GpuTextureFormat): number =>
  pixelSizes[format] ?? 4;

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
    config: GpuSamplerConfiguration = {}
  ) {
    this.wrapModeS = config.wrapModeS ?? 'repeat';
    this.wrapModeT = config.wrapModeT ?? 'repeat';
    this.wrapModeR = config.wrapModeR ?? 'repeat';
    this.minFilter = config.minFilter ?? 'linear';
    this.magFilter = config.magFilter ?? 'linear';
    this.mipmapFilter = config.mipmapFilter ?? 'linear';
    this.maxAnisotropy = config.maxAnisotropy ?? 1;
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
      label
    );
    if (source) {
      texture.write(source);
    }
    return texture;
  }

  createSampler(descriptor?: GpuSamplerConfiguration): VulkanSampler {
    return new VulkanSampler(this._addon, this._context, descriptor);
  }
}
