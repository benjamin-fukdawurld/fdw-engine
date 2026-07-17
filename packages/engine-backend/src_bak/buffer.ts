/**
 * GPU Buffer abstraction
 */

export const BufferUsage = {
  Vertex: 0x0020,
  Index: 0x0010,
  Uniform: 0x0040,
  Storage: 0x0080,
  CopySrc: 0x0004,
  CopyDst: 0x0008,
} as const;
export type BufferUsage = number;

export interface GpuBufferDescriptor {
  label?: string;
  size: number;
  usage: BufferUsage;
  /** If true, the buffer can be mapped for CPU read/write */
  mappedAtCreation?: boolean;
}

export interface GpuBuffer {
  readonly label: string;
  readonly size: number;
  readonly usage: BufferUsage;

  /** Write data to the buffer */
  write(data: ArrayBufferView, offset?: number): void;

  /** Destroy the buffer and release GPU memory */
  destroy(): void;
}
