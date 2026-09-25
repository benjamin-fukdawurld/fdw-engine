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

  _texture?: GPUTexture;

  constructor(config: GpuTextureConfiguration & { texture: GPUTexture }) {
    this._texture = config.texture;
    this.type = config.type;
    this.format = config.format;
    this.dimensions = config.dimensions;
  }

  get label(): string | undefined {
    return this._texture?.label;
  }

  get texture(): GPUTexture | undefined {
    return this._texture;
  }

  get view(): GPUTextureView | undefined {
    return this._texture?.createView({
      dimension: Texture.textureTypeToGPUTextureViewDimension(this.type),
    });
  }

  destroy(): void {
    this._texture?.destroy();
    this._texture = undefined;
  }

  private static textureTypeToGPUTextureViewDimension(
    type: GpuTextureType
  ): GPUTextureViewDimension {
    switch (type) {
      case '2d':
        return '2d';
      case '3d':
        return '3d';
      case 'cube':
        return 'cube';
      default:
        throw new Error(`Unsupported texture type: ${type}`);
    }
  }
}
