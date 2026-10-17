import type {
  GpuBuffer,
  GpuBufferFactory,
  GpuBufferUpdateFrequency,
  GpuBufferUsage,
} from '@fdw/engine-backend';
import { GL } from '../gl';
import { StorageTextureWidth } from '../shader/storage';
import { FramebufferAttachment, framebufferFor } from './framebuffers';

// WebGL2 fixes the kind of a buffer on its first binding: an index buffer
// can never be bound as vertex or uniform data, and conversely. Each buffer
// keeps the target of its main usage.
function targetOf(usage: readonly GpuBufferUsage[]): GLenum {
  if (usage.includes('index')) {
    if (usage.includes('storage')) {
      // An index buffer cannot be bound to the pixel buffer targets that
      // copy it to its texture.
      throw new Error('WebGL2 cannot use a storage buffer as an index buffer');
    }
    return GL.ELEMENT_ARRAY_BUFFER;
  }
  if (usage.includes('uniform')) {
    return GL.UNIFORM_BUFFER;
  }
  if (usage.includes('indirect')) {
    throw new Error('WebGL2 has no indirect commands');
  }
  return GL.ARRAY_BUFFER;
}

function usageHint(
  usage: readonly GpuBufferUsage[],
  frequency: GpuBufferUpdateFrequency | undefined,
): GLenum {
  switch (frequency ?? (usage.includes('copy-dst') ? 'dynamic' : 'static')) {
    case 'stream':
      return GL.STREAM_DRAW;
    case 'dynamic':
      return GL.DYNAMIC_DRAW;
    default:
      return GL.STATIC_DRAW;
  }
}

/**
 * The data texture of a storage buffer: RGBA32UI, the bytes of the buffer
 * in order, 16 per texel, StorageTextureWidth texels per row at most, read
 * by texelFetch and written by rendering to it (see StorageNames). Row 0 is
 * the first, as stored: neither flipped nor sampled.
 */
export class StorageTexture implements FramebufferAttachment {
  readonly format = 'rgba32uint' as const;
  readonly width: number;
  readonly height: number;
  readonly texels: number;
  private _texture?: WebGLTexture;

  constructor(
    private readonly _gl: WebGL2RenderingContext,
    size: number,
    label?: string,
  ) {
    this.texels = Math.ceil(size / 16);
    this.width = Math.min(this.texels, StorageTextureWidth);
    this.height = Math.ceil(this.texels / this.width);
    const max = _gl.getParameter(GL.MAX_TEXTURE_SIZE) as number;
    if (this.height > max) {
      throw new Error(
        `Storage buffer "${label ?? '(unlabeled)'}": ${size} bytes is more than WebGL2 can hold (${
          max * StorageTextureWidth * 16
        })`,
      );
    }
    // Filled with zeros, as the buffer.
    this._texture = _gl.createTexture();
    _gl.bindTexture(GL.TEXTURE_2D, this._texture);
    _gl.texStorage2D(GL.TEXTURE_2D, 1, GL.RGBA32UI, this.width, this.height);
    // Integer textures are complete only without filtering.
    _gl.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST);
    _gl.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MAG_FILTER, GL.NEAREST);
    _gl.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MAX_LEVEL, 0);
  }

  get texture(): WebGLTexture {
    if (!this._texture) {
      throw new Error('The storage buffer was destroyed');
    }
    return this._texture;
  }

  attachTo(gl: WebGL2RenderingContext, point: GLenum): void {
    gl.framebufferTexture2D(
      GL.FRAMEBUFFER,
      point,
      GL.TEXTURE_2D,
      this.texture,
      0,
    );
  }

  // The rows of the texture: the full ones, then the last one, shorter.
  get rows(): readonly {
    y: number;
    width: number;
    height: number;
    offset: number;
  }[] {
    const full = Math.floor(this.texels / this.width);
    const rest = this.texels - full * this.width;
    return [
      ...(full > 0
        ? [{ y: 0, width: this.width, height: full, offset: 0 }]
        : []),
      ...(rest > 0
        ? [{ y: full, width: rest, height: 1, offset: full * this.width * 16 }]
        : []),
    ];
  }

  destroy(): void {
    if (this._texture) {
      this._gl.deleteTexture(this._texture);
      this._texture = undefined;
    }
  }
}

export class WebGl2Buffer implements GpuBuffer {
  readonly target: GLenum;
  /**
   * The data texture of a storage buffer, which programs read and compute
   * stages write; the buffer itself serves the other usages. Each copy is
   * brought up to date from the other on the GPU (through a pixel buffer)
   * before it is used, when the other one changed.
   */
  readonly storage?: StorageTexture;
  // The copy written last, when the other one is behind.
  private _newer?: 'buffer' | 'texture';
  private _buffer?: WebGLBuffer;

  constructor(
    private readonly _gl: WebGL2RenderingContext,
    readonly size: number,
    readonly usage: readonly GpuBufferUsage[],
    frequency: GpuBufferUpdateFrequency | undefined,
    readonly label?: string,
  ) {
    this.target = targetOf(usage);
    if (usage.includes('storage')) {
      this.storage = new StorageTexture(_gl, size, label);
    }
    this._buffer = _gl.createBuffer();
    this.bind();
    // Whole texels for a storage buffer, copied to its texture and back.
    _gl.bufferData(
      this.target,
      this.storage ? this.storage.texels * 16 : size,
      usageHint(usage, frequency),
    );
  }

  get buffer(): WebGLBuffer {
    if (!this._buffer) {
      throw new Error(`Buffer "${this.label ?? '(unlabeled)'}" was destroyed`);
    }
    return this._buffer;
  }

  write(
    offset: number,
    value: ArrayBuffer,
    dataOffset = 0,
    size?: number,
  ): void {
    const byteLength = size ?? value.byteLength - dataOffset;
    if (dataOffset + byteLength > value.byteLength) {
      throw new Error(
        `Write of ${byteLength} bytes from offset ${dataOffset} exceeds source data size ${value.byteLength}`,
      );
    }
    if (offset + byteLength > this.size) {
      throw new Error(
        `Write of ${byteLength} bytes at ${offset} exceeds buffer size ${this.size}`,
      );
    }
    // The rest of the buffer, from the texture written by the commands
    // submitted so far.
    this.updateBuffer();
    this.bind();
    this._gl.bufferSubData(
      this.target,
      offset,
      new Uint8Array(value, dataOffset, byteLength),
    );
    this.changed('buffer');
  }

  // WebGL reads synchronously: the commands submitted so far are done when
  // the read returns.
  async read(offset = 0, size = this.size - offset): Promise<ArrayBuffer> {
    this.updateBuffer();
    const data = new Uint8Array(size);
    this._gl.bindBuffer(GL.COPY_READ_BUFFER, this.buffer);
    this._gl.getBufferSubData(GL.COPY_READ_BUFFER, offset, data);
    return data.buffer;
  }

  destroy(): void {
    if (this._buffer) {
      this._gl.deleteBuffer(this._buffer);
      this._buffer = undefined;
    }
    this.storage?.destroy();
  }

  /**
   * Records a change of one of the copies of a storage buffer: the buffer
   * (written, copied to) or the texture (rendered to).
   */
  changed(copy: 'buffer' | 'texture'): void {
    if (this.storage) {
      this._newer = copy;
    }
  }

  /**
   * Brings the buffer up to date, before a use other than storage: the
   * texture read into it, on the GPU, through PIXEL_PACK_BUFFER. Binds the
   * read framebuffer.
   */
  updateBuffer(): void {
    const storage = this.storage;
    if (!storage || this._newer !== 'texture') {
      return;
    }
    const gl = this._gl;
    const framebuffer = framebufferFor(gl, storage);
    gl.bindFramebuffer(GL.READ_FRAMEBUFFER, framebuffer);
    gl.readBuffer(GL.COLOR_ATTACHMENT0);
    gl.bindBuffer(GL.PIXEL_PACK_BUFFER, this.buffer);
    gl.pixelStorei(GL.PACK_ALIGNMENT, 4);
    for (const { y, width, height, offset } of storage.rows) {
      gl.readPixels(
        0,
        y,
        width,
        height,
        GL.RGBA_INTEGER,
        GL.UNSIGNED_INT,
        offset,
      );
    }
    gl.bindBuffer(GL.PIXEL_PACK_BUFFER, null);
    this._newer = undefined;
  }

  /**
   * Brings the texture of a storage buffer up to date, before a program
   * reads or writes it: the buffer copied into it, on the GPU, through
   * PIXEL_UNPACK_BUFFER.
   */
  updateTexture(): void {
    const storage = this.storage;
    if (!storage || this._newer !== 'buffer') {
      return;
    }
    const gl = this._gl;
    gl.bindBuffer(GL.PIXEL_UNPACK_BUFFER, this.buffer);
    gl.bindTexture(GL.TEXTURE_2D, storage.texture);
    gl.pixelStorei(GL.UNPACK_ALIGNMENT, 4);
    gl.pixelStorei(GL.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(GL.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    for (const { y, width, height, offset } of storage.rows) {
      gl.texSubImage2D(
        GL.TEXTURE_2D,
        0,
        0,
        y,
        width,
        height,
        GL.RGBA_INTEGER,
        GL.UNSIGNED_INT,
        offset,
      );
    }
    gl.bindBuffer(GL.PIXEL_UNPACK_BUFFER, null);
    this._newer = undefined;
  }

  private bind(): void {
    if (this.target === GL.ELEMENT_ARRAY_BUFFER) {
      // The index buffer binding belongs to the bound vertex array: unbind
      // it first, not to change the one of a pipeline.
      this._gl.bindVertexArray(null);
    }
    this._gl.bindBuffer(this.target, this.buffer);
  }
}

export class WebGl2BufferFactory implements GpuBufferFactory {
  constructor(private readonly _gl: WebGL2RenderingContext) {}

  create({
    size,
    usage,
    label,
    initialData,
    updateFrequency,
  }: {
    size: number;
    usage: readonly GpuBufferUsage[];
    label?: string;
    initialData?: ArrayBufferView<ArrayBuffer>;
    updateFrequency?: GpuBufferUpdateFrequency;
  }): WebGl2Buffer {
    if (size < 1) {
      throw new Error('Size must be greater than 0');
    }
    if (initialData && initialData.byteLength !== size) {
      throw new Error(
        `Initial data size (${initialData.byteLength}) does not match the buffer size (${size}).`,
      );
    }
    const buffer = new WebGl2Buffer(
      this._gl,
      size,
      usage,
      updateFrequency,
      label,
    );
    if (initialData) {
      buffer.write(
        0,
        initialData.buffer,
        initialData.byteOffset,
        initialData.byteLength,
      );
    }
    return buffer;
  }
}
