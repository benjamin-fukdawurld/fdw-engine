import type { GpuRenderTarget, GpuTextureFormat } from '@fdw/engine-backend';
import { GL } from '../gl';
import { glTextureFormat } from '../gpu/formats';

const noDepth = {};

// A color or depth image that can be rendered to. Color targets are textures
// (they can be read back or sampled), depth targets renderbuffers. The
// framebuffers combining a color target with a depth target are created on
// first use.
export class WebGl2RenderTarget implements GpuRenderTarget {
  private _texture?: WebGLTexture;
  private _renderbuffer?: WebGLRenderbuffer;
  // Framebuffers of this color target, by depth target.
  private readonly _framebuffers = new WeakMap<object, WebGLFramebuffer>();
  // Every framebuffer this target is attached to, deleted with it.
  private readonly _attachedTo = new Set<WebGLFramebuffer>();

  constructor(
    private readonly _gl: WebGL2RenderingContext,
    readonly width: number,
    readonly height: number,
    readonly format: GpuTextureFormat,
    readonly label?: string
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

  get isDepth(): boolean {
    return this._renderbuffer !== undefined;
  }

  // The framebuffer rendering to this color target and the given depth
  // target.
  framebuffer(depth?: WebGl2RenderTarget): WebGLFramebuffer {
    const gl = this._gl;
    const key = depth ?? noDepth;
    let framebuffer = this._framebuffers.get(key);
    if (framebuffer) {
      return framebuffer;
    }
    if (!this._texture) {
      throw new Error('A depth target cannot be used as a color attachment');
    }
    framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(GL.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(
      GL.FRAMEBUFFER,
      GL.COLOR_ATTACHMENT0,
      GL.TEXTURE_2D,
      this._texture,
      0
    );
    if (depth) {
      if (!depth._renderbuffer) {
        throw new Error('A color target cannot be used as a depth attachment');
      }
      gl.framebufferRenderbuffer(
        GL.FRAMEBUFFER,
        depth.format.includes('stencil')
          ? GL.DEPTH_STENCIL_ATTACHMENT
          : GL.DEPTH_ATTACHMENT,
        GL.RENDERBUFFER,
        depth._renderbuffer
      );
      depth._attachedTo.add(framebuffer);
    }
    const status = gl.checkFramebufferStatus(GL.FRAMEBUFFER);
    if (status !== GL.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(framebuffer);
      throw new Error(
        `Framebuffer incomplete (0x${status.toString(16)}) for ${this.format}${
          depth ? ` and ${depth.format}` : ''
        }`
      );
    }
    this._framebuffers.set(key, framebuffer);
    this._attachedTo.add(framebuffer);
    return framebuffer;
  }

  destroy(): void {
    for (const framebuffer of this._attachedTo) {
      this._gl.deleteFramebuffer(framebuffer);
    }
    this._attachedTo.clear();
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
