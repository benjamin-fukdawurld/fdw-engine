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

// A tree of WeakMaps: the color attachments in order, then the depth
// attachment (or noDepth), lead to the framebuffer.
interface CacheNode {
  readonly next: WeakMap<object, CacheNode>;
  framebuffer?: WebGLFramebuffer;
}
const roots = new WeakMap<WebGL2RenderingContext, CacheNode>();
// Every framebuffer an attachment is part of, deleted with it.
const attachedTo = new WeakMap<object, Set<WebGLFramebuffer>>();
// The framebuffers deleted: their cache entries are recreated if found.
const deleted = new WeakSet<WebGLFramebuffer>();

const depthPoint = (format: GpuTextureFormat) =>
  format.includes('stencil')
    ? GL.DEPTH_STENCIL_ATTACHMENT
    : GL.DEPTH_ATTACHMENT;

/**
 * The framebuffer rendering to color attachments (COLOR_ATTACHMENT0, 1…, in
 * order) and a depth attachment (either can be absent), created on first
 * use. Its draw buffers are its color attachments.
 */
export function framebufferFor(
  gl: WebGL2RenderingContext,
  color: FramebufferAttachment | readonly FramebufferAttachment[] | undefined,
  depth?: FramebufferAttachment,
): WebGLFramebuffer {
  const colors = color === undefined ? [] : 'length' in color ? color : [color];
  if (colors.length === 0 && !depth) {
    throw new Error('A framebuffer needs a color or a depth attachment');
  }
  let node: CacheNode | undefined = roots.get(gl);
  if (!node) {
    node = { next: new WeakMap() };
    roots.set(gl, node);
  }
  for (const key of [...colors, depth ?? noDepth]) {
    let next: CacheNode | undefined = node.next.get(key);
    if (!next) {
      next = { next: new WeakMap() };
      node.next.set(key, next);
    }
    node = next;
  }
  if (node.framebuffer && !deleted.has(node.framebuffer)) {
    return node.framebuffer;
  }

  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(GL.FRAMEBUFFER, framebuffer);
  colors.forEach((attachment, i) =>
    attachment.attachTo(gl, GL.COLOR_ATTACHMENT0 + i),
  );
  if (colors.length === 0) {
    // Depth only.
    gl.drawBuffers([GL.NONE]);
    gl.readBuffer(GL.NONE);
  } else if (colors.length > 1) {
    gl.drawBuffers(colors.map((_, i) => GL.COLOR_ATTACHMENT0 + i));
  }
  if (depth) {
    depth.attachTo(gl, depthPoint(depth.format));
  }
  const status = gl.checkFramebufferStatus(GL.FRAMEBUFFER);
  if (status !== GL.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(framebuffer);
    throw new Error(
      `Framebuffer incomplete (0x${status.toString(16)}) for ${[
        ...colors,
        depth,
      ]
        .filter((attachment) => attachment)
        .map((attachment) => attachment?.format)
        .join(' and ')}`,
    );
  }
  node.framebuffer = framebuffer;
  for (const attachment of [...colors, depth]) {
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
  attachment: FramebufferAttachment,
): void {
  for (const framebuffer of attachedTo.get(attachment) ?? []) {
    gl.deleteFramebuffer(framebuffer);
    deleted.add(framebuffer);
  }
  attachedTo.delete(attachment);
}
