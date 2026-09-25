import {
  GpuSampler,
  GpuSamplerConfiguration,
  GpuTextureFilterMode,
  GpuTextureWrapMode,
} from '@fdw/engine-backend';

export class Sampler implements GpuSampler {
  readonly wrapModeS: GpuTextureWrapMode;
  readonly wrapModeT: GpuTextureWrapMode;
  readonly wrapModeR: GpuTextureWrapMode;
  readonly minFilter: GpuTextureFilterMode;
  readonly magFilter: GpuTextureFilterMode;
  readonly mipmapFilter: GpuTextureFilterMode;
  readonly maxAnisotropy: number;

  _sampler?: GPUSampler;

  constructor(config: GpuSamplerConfiguration & { sampler: GPUSampler }) {
    this.wrapModeS = config.wrapModeS ?? 'repeat';
    this.wrapModeT = config.wrapModeT ?? 'repeat';
    this.wrapModeR = config.wrapModeR ?? 'repeat';
    this.minFilter = config.minFilter ?? 'linear';
    this.magFilter = config.magFilter ?? 'linear';
    this.mipmapFilter = config.mipmapFilter ?? 'linear';
    this.maxAnisotropy = config.maxAnisotropy ?? 1;
    this._sampler = config.sampler;
  }

  get label(): string | undefined {
    return this._sampler?.label;
  }

  get sampler(): GPUSampler | undefined {
    return this._sampler;
  }

  destroy(): void {
    this._sampler = undefined;
  }
}
