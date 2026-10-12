import {
  GpuTexture,
  GpuTextureConfiguration,
  GpuTextureDimensions,
  GpuTextureFormat,
  GpuTextureType,
} from '@fdw/engine-backend';

export class Texture implements GpuTexture {
  readonly type: GpuTextureType;
  readonly format: GpuTextureFormat;
  readonly dimensions: GpuTextureDimensions;
  readonly sampleCount: number;
  readonly mipLevelCount: number;

  _texture?: GPUTexture;
  private _view?: GPUTextureView;
  private _attachmentView?: GPUTextureView;

  constructor(config: GpuTextureConfiguration & { texture: GPUTexture }) {
    this._texture = config.texture;
    this.type = config.type;
    this.format = config.format;
    this.dimensions = config.dimensions;
    this.sampleCount = config.sampleCount ?? 1;
    this.mipLevelCount = config.mipLevelCount ?? 1;
  }

  get width(): number {
    return this.dimensions.width;
  }

  get height(): number {
    return this.dimensions.height ?? 1;
  }

  get label(): string | undefined {
    return this._texture?.label;
  }

  get texture(): GPUTexture | undefined {
    return this._texture;
  }

  // Created once: a view per access would allocate on every bind group.
  get view(): GPUTextureView | undefined {
    if (!this._view && this._texture) {
      this._view = this._texture.createView({
        dimension: Texture.textureTypeToGPUTextureViewDimension(this.type),
      });
    }
    return this._view;
  }

  // The view rendered to: the first level (an attachment has one level).
  get attachmentView(): GPUTextureView | undefined {
    if (this.mipLevelCount === 1) {
      return this.view;
    }
    if (!this._attachmentView && this._texture) {
      this._attachmentView = this._texture.createView({
        dimension: '2d',
        mipLevelCount: 1,
        arrayLayerCount: 1,
      });
    }
    return this._attachmentView;
  }

  destroy(): void {
    this._texture?.destroy();
    this._texture = undefined;
    this._view = undefined;
    this._attachmentView = undefined;
  }

  private static textureTypeToGPUTextureViewDimension(
    type: GpuTextureType
  ): GPUTextureViewDimension {
    switch (type) {
      case '2d':
        return '2d';
      case '2d-array':
        return '2d-array';
      case '3d':
        return '3d';
      case 'cube':
        return 'cube';
      default:
        throw new Error(`Unsupported texture type: ${type}`);
    }
  }
}
