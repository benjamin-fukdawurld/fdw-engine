import type { GpuTextureFormat } from '@fdw/engine-backend';
import { GL, lazy } from '../gl';

export interface GlTextureFormat {
  readonly internalFormat: GLenum;
  readonly format: GLenum;
  readonly type: GLenum;
  readonly bytesPerPixel: number;
  readonly depth?: boolean;
}

const color = (
  internalFormat: GLenum,
  format: GLenum,
  type: GLenum,
  bytesPerPixel: number
): GlTextureFormat => ({ internalFormat, format, type, bytesPerPixel });

const formats = lazy(
  (): Record<string, GlTextureFormat> => ({
    r8unorm: color(GL.R8, GL.RED, GL.UNSIGNED_BYTE, 1),
    rg8unorm: color(GL.RG8, GL.RG, GL.UNSIGNED_BYTE, 2),
    rgba8unorm: color(GL.RGBA8, GL.RGBA, GL.UNSIGNED_BYTE, 4),
    'rgba8unorm-srgb': color(GL.SRGB8_ALPHA8, GL.RGBA, GL.UNSIGNED_BYTE, 4),
    // OpenGL has no BGRA formats: the surfaces use RGBA, which reads the same
    // from the shaders.
    bgra8unorm: color(GL.RGBA8, GL.RGBA, GL.UNSIGNED_BYTE, 4),
    'bgra8unorm-srgb': color(GL.SRGB8_ALPHA8, GL.RGBA, GL.UNSIGNED_BYTE, 4),

    r16float: color(GL.R16F, GL.RED, GL.HALF_FLOAT, 2),
    rg16float: color(GL.RG16F, GL.RG, GL.HALF_FLOAT, 4),
    rgba16float: color(GL.RGBA16F, GL.RGBA, GL.HALF_FLOAT, 8),
    r32float: color(GL.R32F, GL.RED, GL.FLOAT, 4),
    rg32float: color(GL.RG32F, GL.RG, GL.FLOAT, 8),
    rgba32float: color(GL.RGBA32F, GL.RGBA, GL.FLOAT, 16),

    r8uint: color(GL.R8UI, GL.RED_INTEGER, GL.UNSIGNED_BYTE, 1),
    rg8uint: color(GL.RG8UI, GL.RG_INTEGER, GL.UNSIGNED_BYTE, 2),
    rgba8uint: color(GL.RGBA8UI, GL.RGBA_INTEGER, GL.UNSIGNED_BYTE, 4),
    r16uint: color(GL.R16UI, GL.RED_INTEGER, GL.UNSIGNED_SHORT, 2),
    rg16uint: color(GL.RG16UI, GL.RG_INTEGER, GL.UNSIGNED_SHORT, 4),
    rgba16uint: color(GL.RGBA16UI, GL.RGBA_INTEGER, GL.UNSIGNED_SHORT, 8),
    r32uint: color(GL.R32UI, GL.RED_INTEGER, GL.UNSIGNED_INT, 4),
    rg32uint: color(GL.RG32UI, GL.RG_INTEGER, GL.UNSIGNED_INT, 8),
    rgba32uint: color(GL.RGBA32UI, GL.RGBA_INTEGER, GL.UNSIGNED_INT, 16),

    r8sint: color(GL.R8I, GL.RED_INTEGER, GL.BYTE, 1),
    rg8sint: color(GL.RG8I, GL.RG_INTEGER, GL.BYTE, 2),
    rgba8sint: color(GL.RGBA8I, GL.RGBA_INTEGER, GL.BYTE, 4),
    r16sint: color(GL.R16I, GL.RED_INTEGER, GL.SHORT, 2),
    rg16sint: color(GL.RG16I, GL.RG_INTEGER, GL.SHORT, 4),
    rgba16sint: color(GL.RGBA16I, GL.RGBA_INTEGER, GL.SHORT, 8),
    r32sint: color(GL.R32I, GL.RED_INTEGER, GL.INT, 4),
    rg32sint: color(GL.RG32I, GL.RG_INTEGER, GL.INT, 8),
    rgba32sint: color(GL.RGBA32I, GL.RGBA_INTEGER, GL.INT, 16),

    rgb10a2unorm: color(
      GL.RGB10_A2,
      GL.RGBA,
      GL.UNSIGNED_INT_2_10_10_10_REV,
      4
    ),

    depth16unorm: {
      ...color(GL.DEPTH_COMPONENT16, GL.DEPTH_COMPONENT, GL.UNSIGNED_SHORT, 2),
      depth: true,
    },
    depth24plus: {
      ...color(GL.DEPTH_COMPONENT24, GL.DEPTH_COMPONENT, GL.UNSIGNED_INT, 4),
      depth: true,
    },
    'depth24plus-stencil8': {
      ...color(GL.DEPTH24_STENCIL8, GL.DEPTH_STENCIL, GL.UNSIGNED_INT_24_8, 4),
      depth: true,
    },
    depth32float: {
      ...color(GL.DEPTH_COMPONENT32F, GL.DEPTH_COMPONENT, GL.FLOAT, 4),
      depth: true,
    },
  })
);

export function glTextureFormat(format: GpuTextureFormat): GlTextureFormat {
  const result = formats()[format];
  if (!result) {
    throw new Error(`Texture format ${format} is not supported by WebGL2`);
  }
  return result;
}
