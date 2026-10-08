import type {
  GpuBuffer,
  GpuBufferFactory,
  GpuBufferUpdateFrequency,
  GpuBufferUsage,
} from '@fdw/engine-backend';
import { GL } from '../gl';

// WebGL2 fixes the kind of a buffer on its first binding: an index buffer
// can never be bound as vertex or uniform data, and conversely. Each buffer
// keeps the target of its main usage.
function targetOf(usage: readonly GpuBufferUsage[]): GLenum {
  if (usage.includes('index')) {
    return GL.ELEMENT_ARRAY_BUFFER;
  }
  if (usage.includes('uniform')) {
    return GL.UNIFORM_BUFFER;
  }
  if (usage.includes('storage')) {
    throw new Error('WebGL2 has no storage buffers');
  }
  return GL.ARRAY_BUFFER;
}

function usageHint(
  usage: readonly GpuBufferUsage[],
  frequency: GpuBufferUpdateFrequency | undefined
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

export class WebGl2Buffer implements GpuBuffer {
  readonly target: GLenum;
  private _buffer?: WebGLBuffer;

  constructor(
    private readonly _gl: WebGL2RenderingContext,
    readonly size: number,
    readonly usage: readonly GpuBufferUsage[],
    frequency: GpuBufferUpdateFrequency | undefined,
    readonly label?: string
  ) {
    this.target = targetOf(usage);
    this._buffer = _gl.createBuffer();
    this.bind();
    _gl.bufferData(this.target, size, usageHint(usage, frequency));
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
    size?: number
  ): void {
    const byteLength = size ?? value.byteLength - dataOffset;
    if (dataOffset + byteLength > value.byteLength) {
      throw new Error(
        `Write of ${byteLength} bytes from offset ${dataOffset} exceeds source data size ${value.byteLength}`
      );
    }
    if (offset + byteLength > this.size) {
      throw new Error(
        `Write of ${byteLength} bytes at ${offset} exceeds buffer size ${this.size}`
      );
    }
    this.bind();
    this._gl.bufferSubData(
      this.target,
      offset,
      new Uint8Array(value, dataOffset, byteLength)
    );
  }

  destroy(): void {
    if (this._buffer) {
      this._gl.deleteBuffer(this._buffer);
      this._buffer = undefined;
    }
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
        `Initial data size (${initialData.byteLength}) does not match the buffer size (${size}).`
      );
    }
    const buffer = new WebGl2Buffer(
      this._gl,
      size,
      usage,
      updateFrequency,
      label
    );
    if (initialData) {
      buffer.write(
        0,
        initialData.buffer,
        initialData.byteOffset,
        initialData.byteLength
      );
    }
    return buffer;
  }
}
