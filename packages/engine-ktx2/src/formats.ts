import type { GpuTextureFormat } from '@fdw/engine-backend';

/**
 * The engine format of each `VkFormat` a KTX2 file can hold, linear: the
 * sRGB formats map to their linear base, since the color space is a choice
 * of the texture (§6.9 of the design).
 */
export const vkFormats: ReadonlyMap<number, GpuTextureFormat> = new Map<
  number,
  GpuTextureFormat
>([
  // 8 bits per channel.
  [9, 'r8unorm'], // R8_UNORM
  [15, 'r8unorm'], // R8_SRGB
  [13, 'r8uint'],
  [14, 'r8sint'],
  [16, 'rg8unorm'], // R8G8_UNORM
  [22, 'rg8unorm'], // R8G8_SRGB
  [20, 'rg8uint'],
  [21, 'rg8sint'],
  [37, 'rgba8unorm'], // R8G8B8A8_UNORM
  [43, 'rgba8unorm'], // R8G8B8A8_SRGB
  [41, 'rgba8uint'],
  [42, 'rgba8sint'],
  [44, 'bgra8unorm'], // B8G8R8A8_UNORM
  [50, 'bgra8unorm'], // B8G8R8A8_SRGB
  [64, 'rgb10a2unorm'], // A2B10G10R10_UNORM_PACK32
  // 16 bits per channel.
  [74, 'r16uint'],
  [75, 'r16sint'],
  [76, 'r16float'],
  [81, 'rg16uint'],
  [82, 'rg16sint'],
  [83, 'rg16float'],
  [95, 'rgba16uint'],
  [96, 'rgba16sint'],
  [97, 'rgba16float'],
  // 32 bits per channel.
  [98, 'r32uint'],
  [99, 'r32sint'],
  [100, 'r32float'],
  [101, 'rg32uint'],
  [102, 'rg32sint'],
  [103, 'rg32float'],
  [107, 'rgba32uint'],
  [108, 'rgba32sint'],
  [109, 'rgba32float'],
  // BC (desktop). BC1 without alpha has the blocks of BC1 with alpha.
  [131, 'bc1-rgba-unorm'], // BC1_RGB_UNORM_BLOCK
  [132, 'bc1-rgba-unorm'], // BC1_RGB_SRGB_BLOCK
  [133, 'bc1-rgba-unorm'],
  [134, 'bc1-rgba-unorm'],
  [137, 'bc3-rgba-unorm'],
  [138, 'bc3-rgba-unorm'],
  [139, 'bc4-r-unorm'],
  [141, 'bc5-rg-unorm'],
  [143, 'bc6h-rgb-ufloat'],
  [145, 'bc7-rgba-unorm'],
  [146, 'bc7-rgba-unorm'],
  // ETC2 and EAC (mobile, OpenGL ES 3).
  [147, 'etc2-rgb8unorm'], // ETC2_R8G8B8_UNORM_BLOCK
  [148, 'etc2-rgb8unorm'],
  [151, 'etc2-rgba8unorm'], // ETC2_R8G8B8A8_UNORM_BLOCK
  [152, 'etc2-rgba8unorm'],
  [153, 'eac-r11unorm'],
  [155, 'eac-rg11unorm'],
  // ASTC (mobile).
  [157, 'astc-4x4-unorm'],
  [158, 'astc-4x4-unorm'],
]);

/** The engine format of a `VkFormat`: undefined for those the engine lacks (and for 0, Basis Universal). */
export const engineFormat = (vkFormat: number): GpuTextureFormat | undefined =>
  vkFormats.get(vkFormat);
