import type { GpuRenderTarget, GpuTextureFormat } from '@fdw/engine-backend';
import { GL } from '../gl';
import { glTextureFormat } from '../gpu/formats';
import {
  FramebufferAttachment,
  framebufferFor,
  releaseFramebuffers,
} from '../gpu/framebuffers';

// A color or depth image that can be rendered to. Color targets are textures
// (they can be read back or sampled), depth targets renderbuffers. The
// framebuffers combining a color target with a depth target are created on
// first use.
export class WebGl2RenderTarget
  implements GpuRenderTarget, FramebufferAttachment
{
  private _texture?: WebGLTexture;
  private _renderbuffer?: WebGLRenderbuffer;

  constructor(
    private readonly _gl: WebGL2RenderingContext,
    readonly width: number,
    readonly height: number,
    readonly format: GpuTextureFormat,
    readonly label?: string,
  ) {
    const { internalFormat, depth } = glTextureFormat(format);
    if (depth) {
      this._renderbuffer = _gl.createRenderbuffer();
      _gl.bindRenderbuffer(GL.RENDERBUFFER, this._renderbuffer);
      _gl.renderbufferStorage(GL.RENDERBUFFER, internalFormat, width, height);
    } else {
      this._texture = _gl.createTexture();
      _gl.bindTexture(GL.TEXTURE_2D, this._texture);
      _gl.texStorage2D(GL.TEXTURE_2D, 1, internalFormat, width, height);
      _gl.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MAX_LEVEL, 0);
    }
  }

  // The texture of a color target, for copies.
  get texture(): WebGLTexture | undefined {
    return this._texture;
  }

  get isDepth(): boolean {
    return this._renderbuffer !== undefined;
  }

  attachTo(gl: WebGL2RenderingContext, point: GLenum): void {
    if (this._renderbuffer) {
      gl.framebufferRenderbuffer(
        GL.FRAMEBUFFER,
        point,
        GL.RENDERBUFFER,
        this._renderbuffer,
      );
    } else {
      gl.framebufferTexture2D(
        GL.FRAMEBUFFER,
        point,
        GL.TEXTURE_2D,
        this._texture ?? null,
        0,
      );
    }
  }

  // The framebuffer rendering to this color target and the given depth
  // target.
  framebuffer(depth?: FramebufferAttachment): WebGLFramebuffer {
    if (this.isDepth) {
      throw new Error('A depth target cannot be used as a color attachment');
    }
    return framebufferFor(this._gl, this, depth);
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
