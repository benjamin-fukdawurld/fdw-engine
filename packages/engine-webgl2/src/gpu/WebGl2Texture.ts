import {
  canGenerateMipmaps,
  checkMipLevelCount,
  checkReadRegion,
  defaultTextureUsage,
  samplerAnisotropy,
} from '@fdw/engine-backend';
import type {
  CompareFunction,
  GpuSampler,
  GpuSamplerConfiguration,
  GpuSamplerFactory,
  GpuTexture,
  GpuTextureConfiguration,
  GpuTextureDimensions,
  GpuTextureFactory,
  GpuTextureFilterMode,
  GpuTextureFormat,
  GpuTextureRegion,
  GpuTextureType,
  GpuTextureUsage,
  GpuTextureWrapMode,
} from '@fdw/engine-backend';
import { GL, lazy } from '../gl';
import { glTextureFormat } from './formats';
import { FramebufferAttachment, releaseFramebuffers } from './framebuffers';
import { readAttachment } from './readback';

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

export class WebGl2Texture implements GpuTexture, FramebufferAttachment {
  readonly target: GLenum;
  private _texture?: WebGLTexture;
  // Multisampled textures are renderbuffers: they can only be rendered to,
  // then resolved (blitted) into a texture.
  private _renderbuffer?: WebGLRenderbuffer;

  constructor(
    private readonly _gl: WebGL2RenderingContext,
    readonly type: GpuTextureType,
    readonly format: GpuTextureFormat,
    readonly dimensions: GpuTextureDimensions,
    readonly label?: string,
    readonly sampleCount = 1,
    readonly mipLevelCount = 1,
    // As in WebGPU, where they are checked: the copy-src usage is needed to
    // read the texture back.
    readonly usage: readonly GpuTextureUsage[] = defaultTextureUsage
  ) {
    checkMipLevelCount({
      type,
      format,
      dimensions,
      label,
      sampleCount,
      mipLevelCount,
    });
    const target = textureTargets()[type];
    if (target === undefined) {
      throw new Error(`Texture type ${type} is not supported by WebGL2`);
    }
    this.target = target;
    const { internalFormat } = glTextureFormat(format);
    const { width, height = 1, layers = 1 } = dimensions;

    if (sampleCount > 1) {
      if (target !== GL.TEXTURE_2D) {
        throw new Error('Only 2d textures can be multisampled');
      }
      this._renderbuffer = _gl.createRenderbuffer();
      _gl.bindRenderbuffer(GL.RENDERBUFFER, this._renderbuffer);
      // The sample counts depend on the format (fewer for float formats on
      // some devices): the closest supported one, at most the one asked.
      const supported: Int32Array | null = _gl.getInternalformatParameter(
        GL.RENDERBUFFER,
        internalFormat,
        GL.SAMPLES
      );
      const samples = Math.max(
        ...[...(supported ?? [])].filter((count) => count <= sampleCount),
        0
      );
      _gl.renderbufferStorageMultisample(
        GL.RENDERBUFFER,
        samples,
        internalFormat,
        width,
        height
      );
      return;
    }

    this._texture = _gl.createTexture();
    _gl.bindTexture(target, this._texture);
    if (target === GL.TEXTURE_2D_ARRAY || target === GL.TEXTURE_3D) {
      _gl.texStorage3D(
        target,
        mipLevelCount,
        internalFormat,
        width,
        height,
        layers
      );
    } else {
      _gl.texStorage2D(target, mipLevelCount, internalFormat, width, height);
    }
    // Only the levels allocated: the texture stays complete whatever the
    // minification filter of the sampler, as with WebGPU textures.
    _gl.texParameteri(target, GL.TEXTURE_MAX_LEVEL, mipLevelCount - 1);
  }

  get width(): number {
    return this.dimensions.width;
  }

  get height(): number {
    return this.dimensions.height ?? 1;
  }

  // Textures can be rendered to: the first level of a 2d texture.
  attachTo(gl: WebGL2RenderingContext, point: GLenum): void {
    if (this._renderbuffer) {
      gl.framebufferRenderbuffer(
        GL.FRAMEBUFFER,
        point,
        GL.RENDERBUFFER,
        this._renderbuffer
      );
      return;
    }
    if (this.target !== GL.TEXTURE_2D) {
      throw new Error('Only 2d textures can be rendered to');
    }
    gl.framebufferTexture2D(
      GL.FRAMEBUFFER,
      point,
      GL.TEXTURE_2D,
      this.texture,
      0
    );
  }

  /** Computes the levels after the first one (see generateMipmaps). */
  generateMipmaps(gl: WebGL2RenderingContext): void {
    if (this.mipLevelCount === 1) {
      return;
    }
    if (!canGenerateMipmaps(this.format)) {
      throw new Error(
        `The levels of texture "${this.label ?? '(unlabeled)'}" (${
          this.format
        }) cannot be computed`
      );
    }
    gl.bindTexture(this.target, this.texture);
    gl.generateMipmap(this.target);
  }

  get texture(): WebGLTexture {
    if (this._renderbuffer) {
      throw new Error(
        `Texture "${
          this.label ?? '(unlabeled)'
        }" is multisampled: resolve it into a texture to read it`
      );
    }
    if (!this._texture) {
      throw new Error(`Texture "${this.label ?? '(unlabeled)'}" was destroyed`);
    }
    return this._texture;
  }

  // Writes the first level, then computes the others.
  upload(source: WebGl2TextureSource | ArrayBufferView<ArrayBuffer>): void {
    this.writeFirstLevel(source);
    this.generateMipmaps(this._gl);
  }

  private writeFirstLevel(
    source: WebGl2TextureSource | ArrayBufferView<ArrayBuffer>
  ): void {
    const gl = this._gl;
    const { format, type, bytesPerPixel } = glTextureFormat(this.format);
    const { width, height = 1, layers = 1 } = this.dimensions;
    gl.bindTexture(this.target, this.texture);
    // Rows are tightly packed, without premultiplication, as
    // copyExternalImageToTexture in WebGPU. 2d textures are stored bottom row
    // first, like the images OpenGL renders: the first row of the data goes
    // last, and the shaders sample at (u, 1 - v) (see GlslEsCodegen). Uploaded
    // and rendered textures then read the same way, with v pointing down as
    // in WebGPU.
    gl.pixelStorei(GL.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(GL.UNPACK_FLIP_Y_WEBGL, this.target === GL.TEXTURE_2D);
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
    releaseFramebuffers(this._gl, this);
    if (this._texture) {
      this._gl.deleteTexture(this._texture);
      this._texture = undefined;
    }
    if (this._renderbuffer) {
      this._gl.deleteRenderbuffer(this._renderbuffer);
      this._renderbuffer = undefined;
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

// GL comparison functions; GL is read on first use.
const compareFunctions = lazy(
  (): Record<CompareFunction, GLenum> => ({
    never: GL.NEVER,
    less: GL.LESS,
    equal: GL.EQUAL,
    'less-equal': GL.LEQUAL,
    greater: GL.GREATER,
    'not-equal': GL.NOTEQUAL,
    'greater-equal': GL.GEQUAL,
    always: GL.ALWAYS,
  })
);

// The constants of EXT_texture_filter_anisotropic.
const GL_TEXTURE_MAX_ANISOTROPY_EXT = 0x84fe;
const GL_MAX_TEXTURE_MAX_ANISOTROPY_EXT = 0x84ff;

// The anisotropy limit of a context (1 without the extension), enabling
// the extension.
const anisotropyLimits = new WeakMap<WebGL2RenderingContext, number>();
export function maxAnisotropy(gl: WebGL2RenderingContext): number {
  let limit = anisotropyLimits.get(gl);
  if (limit === undefined) {
    limit = gl.getExtension('EXT_texture_filter_anisotropic')
      ? (gl.getParameter(GL_MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number)
      : 1;
    anisotropyLimits.set(gl, limit);
  }
  return limit;
}

export class WebGl2Sampler implements GpuSampler {
  readonly wrapModeS: GpuTextureWrapMode;
  readonly wrapModeT: GpuTextureWrapMode;
  readonly wrapModeR: GpuTextureWrapMode;
  readonly minFilter: GpuTextureFilterMode;
  readonly magFilter: GpuTextureFilterMode;
  readonly mipmapFilter: GpuTextureFilterMode;
  readonly maxAnisotropy: number;
  readonly compare?: CompareFunction;
  readonly label?: string;
  private _sampler?: WebGLSampler;

  constructor(
    private readonly _gl: WebGL2RenderingContext,
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
      maxAnisotropy(_gl)
    );
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
    this.compare = config.compare;
    if (config.compare) {
      _gl.samplerParameteri(
        sampler,
        GL.TEXTURE_COMPARE_MODE,
        GL.COMPARE_REF_TO_TEXTURE
      );
      _gl.samplerParameteri(
        sampler,
        GL.TEXTURE_COMPARE_FUNC,
        compareFunctions()[config.compare]
      );
    }
    if (this.maxAnisotropy > 1) {
      _gl.samplerParameterf(
        sampler,
        // EXT_texture_filter_anisotropic, enabled by maxAnisotropy.
        GL_TEXTURE_MAX_ANISOTROPY_EXT,
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
  defaultMaxAnisotropy = 1;

  constructor(private readonly _gl: WebGL2RenderingContext) {}

  createTexture(
    descriptor: GpuTextureConfiguration & {
      source?: WebGl2TextureSource | ArrayBufferView<ArrayBuffer>;
      readwrite?: boolean;
    }
  ): WebGl2Texture {
    const { type, format, dimensions, source, label, sampleCount } = descriptor;
    const texture = new WebGl2Texture(
      this._gl,
      type,
      format,
      dimensions,
      label,
      sampleCount,
      descriptor.mipLevelCount,
      descriptor.usage
    );
    if (source) {
      texture.upload(source);
    }
    return texture;
  }

  writeTexture(texture: GpuTexture, data: ArrayBufferView<ArrayBuffer>): void {
    (texture as WebGl2Texture).upload(data);
  }

  readTexture(
    texture: GpuTexture,
    region?: GpuTextureRegion
  ): Promise<ArrayBuffer> {
    const checked = checkReadRegion(texture, region);
    if (texture.type !== '2d') {
      throw new Error('Only 2d textures can be read back by WebGL2');
    }
    return readAttachment(this._gl, texture as WebGl2Texture, checked.region);
  }

  createSampler(descriptor?: GpuSamplerConfiguration): GpuSampler {
    return new WebGl2Sampler(this._gl, descriptor, this.defaultMaxAnisotropy);
  }
}
