/**
 * GPU Texture & Sampler abstraction
 */

export type TextureFormat =
  | 'rgba8unorm'
  | 'rgba8unorm-srgb'
  | 'bgra8unorm'
  | 'bgra8unorm-srgb'
  | 'depth24plus'
  | 'depth24plus-stencil8'
  | 'depth32float'
  | 'r32float'
  | 'rg32float'
  | 'rgba32float'
  | 'rgba16float';

export const TextureUsage = {
  CopySrc: 0x01,
  CopyDst: 0x02,
  TextureBinding: 0x04,
  StorageBinding: 0x08,
  RenderAttachment: 0x10,
} as const;
export type TextureUsage = number;

export interface GpuTextureDescriptor {
  label?: string;
  width: number;
  height: number;
  depth?: number;
  mipLevelCount?: number;
  format: TextureFormat;
  usage: number;
}

export interface GpuTexture {
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly format: TextureFormat;

  /** Create a view for binding or rendering */
  createView(): unknown; // Backend-specific view type

  destroy(): void;
}

export interface GpuSamplerDescriptor {
  label?: string;
  magFilter?: 'nearest' | 'linear';
  minFilter?: 'nearest' | 'linear';
  mipmapFilter?: 'nearest' | 'linear';
  addressModeU?: 'clamp-to-edge' | 'repeat' | 'mirror-repeat';
  addressModeV?: 'clamp-to-edge' | 'repeat' | 'mirror-repeat';
  maxAnisotropy?: number;
  compare?: import('./pipeline').CompareFunction;
}

export interface GpuSampler {
  readonly label: string;
}
