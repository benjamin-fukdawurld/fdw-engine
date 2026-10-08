import type {
  GpuSampler,
  GpuSamplerConfiguration,
  GpuSamplerFactory,
  GpuTexture,
  GpuTextureConfiguration,
  GpuTextureDimensions,
  GpuTextureFactory,
  GpuTextureFilterMode,
  GpuTextureFormat,
  GpuTextureType,
  GpuTextureWrapMode,
} from '@fdw/engine-backend';
import { GL, lazy } from '../gl';
import { glTextureFormat } from './formats';

const textureTargets = lazy(
  (): Record<string, GLenum> => ({
    '2d': GL.TEXTURE_2D,
    '2d-array': GL.TEXTURE_2D_ARRAY,
    '3d': GL.TEXTURE_3D,
    cube: GL.TEXTURE_CUBE_MAP,
  })
);

// Image sources accepted by texSubImage2D.
export type WebGl2TextureSource = TexImageSource;

const isImageSource = (source: unknown): source is TexImageSource =>
  typeof source === 'object' && source !== null && !ArrayBuffer.isView(source);

export class WebGl2Texture implements GpuTexture {
  readonly target: GLenum;
  private _texture?: WebGLTexture;

  constructor(
    private readonly _gl: WebGL2RenderingContext,
    readonly type: GpuTextureType,
    readonly format: GpuTextureFormat,
    readonly dimensions: GpuTextureDimensions,
    readonly label?: string
  ) {
    const target = textureTargets()[type];
    if (target === undefined) {
      throw new Error(`Texture type ${type} is not supported by WebGL2`);
    }
    this.target = target;
    const { internalFormat } = glTextureFormat(format);
    const { width, height = 1, layers = 1 } = dimensions;

    this._texture = _gl.createTexture();
    _gl.bindTexture(target, this._texture);
    if (target === GL.TEXTURE_2D_ARRAY || target === GL.TEXTURE_3D) {
      _gl.texStorage3D(target, 1, internalFormat, width, height, layers);
    } else {
      _gl.texStorage2D(target, 1, internalFormat, width, height);
    }
    // A single level: the texture stays complete whatever the minification
    // filter of the sampler, as with WebGPU textures without mipmaps.
    _gl.texParameteri(target, GL.TEXTURE_MAX_LEVEL, 0);
  }

  get texture(): WebGLTexture {
    if (!this._texture) {
      throw new Error(`Texture "${this.label ?? '(unlabeled)'}" was destroyed`);
    }
    return this._texture;
  }

  upload(source: WebGl2TextureSource | ArrayBufferView<ArrayBuffer>): void {
    const gl = this._gl;
    const { format, type, bytesPerPixel } = glTextureFormat(this.format);
    const { width, height = 1, layers = 1 } = this.dimensions;
    gl.bindTexture(this.target, this.texture);
    // Rows are tightly packed, images are uploaded as they are: no vertical
    // flip, no premultiplication, as copyExternalImageToTexture in WebGPU.
    gl.pixelStorei(GL.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(GL.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(GL.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

    if (isImageSource(source)) {
      if (this.target !== GL.TEXTURE_2D) {
        throw new Error('Images can only be uploaded to 2d textures');
      }
      gl.texSubImage2D(
        GL.TEXTURE_2D,
        0,
        0,
        0,
        width,
        height,
        format,
        type,
        source
      );
      return;
    }
    if (this.target === GL.TEXTURE_2D) {
      gl.texSubImage2D(
        GL.TEXTURE_2D,
        0,
        0,
        0,
        width,
        height,
        format,
        type,
        source
      );
    } else if (this.target === GL.TEXTURE_CUBE_MAP) {
      // The six faces follow each other: +x, -x, +y, -y, +z, -z.
      const faceBytes = width * height * bytesPerPixel;
      const bytes = new Uint8Array(
        source.buffer,
        source.byteOffset,
        source.byteLength
      );
      for (let face = 0; face < 6; face++) {
        gl.texSubImage2D(
          GL.TEXTURE_CUBE_MAP_POSITIVE_X + face,
          0,
          0,
          0,
          width,
          height,
          format,
          type,
          bytes.subarray(face * faceBytes, (face + 1) * faceBytes)
        );
      }
    } else {
      gl.texSubImage3D(
        this.target,
        0,
        0,
        0,
        0,
        width,
        height,
        layers,
        format,
        type,
        source
      );
    }
  }

  destroy(): void {
    if (this._texture) {
      this._gl.deleteTexture(this._texture);
      this._texture = undefined;
    }
  }
}

const wrapModes = lazy(
  (): Record<string, GLenum> => ({
    'clamp-to-edge': GL.CLAMP_TO_EDGE,
    repeat: GL.REPEAT,
    'mirror-repeat': GL.MIRRORED_REPEAT,
  })
);

function wrapMode(mode: GpuTextureWrapMode): GLenum {
  const result = wrapModes()[mode];
  if (result === undefined) {
    throw new Error(`Wrap mode ${mode} is not supported by WebGL2`);
  }
  return result;
}

const filter = (mode: GpuTextureFilterMode) =>
  mode === 'nearest' ? GL.NEAREST : GL.LINEAR;

function minFilter(
  min: GpuTextureFilterMode,
  mipmap: GpuTextureFilterMode
): GLenum {
  if (min === 'nearest') {
    return mipmap === 'nearest'
      ? GL.NEAREST_MIPMAP_NEAREST
      : GL.NEAREST_MIPMAP_LINEAR;
  }
  return mipmap === 'nearest'
    ? GL.LINEAR_MIPMAP_NEAREST
    : GL.LINEAR_MIPMAP_LINEAR;
}

export class WebGl2Sampler implements GpuSampler {
  readonly wrapModeS: GpuTextureWrapMode;
  readonly wrapModeT: GpuTextureWrapMode;
  readonly wrapModeR: GpuTextureWrapMode;
  readonly minFilter: GpuTextureFilterMode;
  readonly magFilter: GpuTextureFilterMode;
  readonly mipmapFilter: GpuTextureFilterMode;
  readonly maxAnisotropy: number;
  readonly label?: string;
  private _sampler?: WebGLSampler;

  constructor(
    private readonly _gl: WebGL2RenderingContext,
    config: GpuSamplerConfiguration = {}
  ) {
    this.wrapModeS = config.wrapModeS ?? 'repeat';
    this.wrapModeT = config.wrapModeT ?? 'repeat';
    this.wrapModeR = config.wrapModeR ?? 'repeat';
    this.minFilter = config.minFilter ?? 'linear';
    this.magFilter = config.magFilter ?? 'linear';
    this.mipmapFilter = config.mipmapFilter ?? 'linear';
    this.maxAnisotropy = config.maxAnisotropy ?? 1;
    this.label = config.label;

    const sampler = _gl.createSampler();
    _gl.samplerParameteri(sampler, GL.TEXTURE_WRAP_S, wrapMode(this.wrapModeS));
    _gl.samplerParameteri(sampler, GL.TEXTURE_WRAP_T, wrapMode(this.wrapModeT));
    _gl.samplerParameteri(sampler, GL.TEXTURE_WRAP_R, wrapMode(this.wrapModeR));
    _gl.samplerParameteri(
      sampler,
      GL.TEXTURE_MAG_FILTER,
      filter(this.magFilter)
    );
    _gl.samplerParameteri(
      sampler,
      GL.TEXTURE_MIN_FILTER,
      minFilter(this.minFilter, this.mipmapFilter)
    );
    const anisotropic = _gl.getExtension('EXT_texture_filter_anisotropic');
    if (anisotropic && this.maxAnisotropy > 1) {
      _gl.samplerParameterf(
        sampler,
        anisotropic.TEXTURE_MAX_ANISOTROPY_EXT,
        this.maxAnisotropy
      );
    }
    this._sampler = sampler;
  }

  get sampler(): WebGLSampler {
    if (!this._sampler) {
      throw new Error(`Sampler "${this.label ?? '(unlabeled)'}" was destroyed`);
    }
    return this._sampler;
  }

  destroy(): void {
    if (this._sampler) {
      this._gl.deleteSampler(this._sampler);
      this._sampler = undefined;
    }
  }
}

export class WebGl2TextureFactory
  implements GpuTextureFactory<WebGl2TextureSource>, GpuSamplerFactory
{
  constructor(private readonly _gl: WebGL2RenderingContext) {}

  createTexture(
    descriptor: GpuTextureConfiguration & {
      source?: WebGl2TextureSource | ArrayBufferView<ArrayBuffer>;
      readwrite?: boolean;
    }
  ): WebGl2Texture {
    const { type, format, dimensions, source, label } = descriptor;
    const texture = new WebGl2Texture(
      this._gl,
      type,
      format,
      dimensions,
      label
    );
    if (source) {
      texture.upload(source);
    }
    return texture;
  }

  createSampler(descriptor?: GpuSamplerConfiguration): GpuSampler {
    return new WebGl2Sampler(this._gl, descriptor);
  }
}
