import type { GpuTextureFormat } from '@fdw/engine-backend';
import { GL } from '../gl';

// What a framebuffer can render to: a render target (texture or
// renderbuffer) or a texture.
export interface FramebufferAttachment {
  readonly format: GpuTextureFormat;
  readonly width: number;
  readonly height: number;
  // Attaches the image to the bound framebuffer.
  attachTo(gl: WebGL2RenderingContext, point: GLenum): void;
}

const noDepth = {};
const noColor = {};

// Framebuffers by color attachment, then by depth attachment.
const framebuffers = new WeakMap<object, WeakMap<object, WebGLFramebuffer>>();
// Every framebuffer an attachment is part of, deleted with it.
const attachedTo = new WeakMap<object, Set<WebGLFramebuffer>>();

const depthPoint = (format: GpuTextureFormat) =>
  format.includes('stencil')
    ? GL.DEPTH_STENCIL_ATTACHMENT
    : GL.DEPTH_ATTACHMENT;

// The framebuffer rendering to a color attachment and a depth attachment
// (either can be absent), created on first use.
export function framebufferFor(
  gl: WebGL2RenderingContext,
  color: FramebufferAttachment | undefined,
  depth?: FramebufferAttachment
): WebGLFramebuffer {
  const first = color ?? depth;
  if (!first) {
    throw new Error('A framebuffer needs a color or a depth attachment');
  }
  let bySecond = framebuffers.get(first);
  if (!bySecond) {
    bySecond = new WeakMap();
    framebuffers.set(first, bySecond);
  }
  const key = color ? depth ?? noDepth : noColor;
  let framebuffer = bySecond.get(key);
  if (framebuffer) {
    return framebuffer;
  }

  framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(GL.FRAMEBUFFER, framebuffer);
  if (color) {
    color.attachTo(gl, GL.COLOR_ATTACHMENT0);
  } else {
    // Depth only.
    gl.drawBuffers([GL.NONE]);
    gl.readBuffer(GL.NONE);
  }
  if (depth) {
    depth.attachTo(gl, depthPoint(depth.format));
  }
  const status = gl.checkFramebufferStatus(GL.FRAMEBUFFER);
  if (status !== GL.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(framebuffer);
    throw new Error(
      `Framebuffer incomplete (0x${status.toString(16)}) for ${[color, depth]
        .filter((attachment) => attachment)
        .map((attachment) => attachment?.format)
        .join(' and ')}`
    );
  }
  bySecond.set(key, framebuffer);
  for (const attachment of [color, depth]) {
    if (!attachment) {
      continue;
    }
    let set = attachedTo.get(attachment);
    if (!set) {
      set = new Set();
      attachedTo.set(attachment, set);
    }
    set.add(framebuffer);
  }
  return framebuffer;
}

// Deletes the framebuffers an attachment is part of, when it is destroyed.
export function releaseFramebuffers(
  gl: WebGL2RenderingContext,
  attachment: FramebufferAttachment
): void {
  for (const framebuffer of attachedTo.get(attachment) ?? []) {
    gl.deleteFramebuffer(framebuffer);
  }
  attachedTo.delete(attachment);
  framebuffers.delete(attachment);
}
