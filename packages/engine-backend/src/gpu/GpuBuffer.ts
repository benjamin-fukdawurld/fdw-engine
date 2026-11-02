export type GpuBufferUsage =
  | 'uniform'
  | 'storage'
  | 'vertex'
  | 'index'
  | 'indirect'
  | 'copy-src'
  | 'copy-dst';

export type GpuBufferUpdateFrequency = 'static' | 'dynamic' | 'stream';

export interface GpuBuffer {
  readonly size: number;
  readonly usage: readonly GpuBufferUsage[];
  readonly label?: string;

  write(
    offset: number,
    value: ArrayBuffer,
    dataOffset?: number,
    size?: number,
  ): void;

  // Reads the content of the buffer back, once the GPU commands submitted so
  // far are done. The buffer needs the 'copy-src' usage.
  read(offset?: number, size?: number): Promise<ArrayBuffer>;

  destroy(): void;
}

export interface GpuBufferFactory {
  create(params: {
    size: number;
    usage: readonly GpuBufferUsage[];
    label?: string;
    initialData?: ArrayBufferView<ArrayBuffer>;
    updateFrequency?: GpuBufferUpdateFrequency;
  }): GpuBuffer;
}

/**
 * Checks a write to a buffer (see GpuBuffer.write), the same on every
 * backend: the 'copy-dst' usage (not for the initial data), an offset and a
 * size multiple of 4 (WebGPU copies by 4 bytes; the last bytes of a buffer
 * whose size is not a multiple of 4 can be written alone), and the ranges
 * inside the source and the buffer. Returns the bytes written.
 */
export function checkBufferWrite(
  buffer: Pick<GpuBuffer, 'size' | 'usage' | 'label'>,
  offset: number,
  value: ArrayBuffer,
  dataOffset = 0,
  size?: number,
  options: { readonly initial?: boolean } = {},
): number {
  const what = `Buffer "${buffer.label ?? '(unlabeled)'}"`;
  if (!options.initial && !buffer.usage.includes('copy-dst')) {
    throw new Error(
      `${what} was not created with 'copy-dst' usage and cannot be written to after creation.`,
    );
  }
  const byteLength = size ?? value.byteLength - dataOffset;
  if (
    ![offset, dataOffset, byteLength].every(Number.isInteger) ||
    offset < 0 ||
    dataOffset < 0 ||
    byteLength < 0
  ) {
    throw new Error(
      `${what}: invalid write of ${byteLength} bytes at ${offset} from ${dataOffset}`,
    );
  }
  if (offset % 4 !== 0) {
    throw new Error(`Write offset must be a multiple of 4 (got ${offset})`);
  }
  if (dataOffset + byteLength > value.byteLength) {
    throw new Error(
      `Write of ${byteLength} bytes from offset ${dataOffset} exceeds source data size ${value.byteLength}`,
    );
  }
  if (offset + byteLength > buffer.size) {
    throw new Error(
      `Write of ${byteLength} bytes at ${offset} exceeds buffer size ${buffer.size}`,
    );
  }
  // Padded to 4 bytes, a shorter write would overwrite the next bytes.
  if (byteLength % 4 !== 0 && offset + byteLength !== buffer.size) {
    throw new Error(
      `${what}: the size of a write must be a multiple of 4, unless it ends the buffer (${byteLength} bytes at ${offset} of ${buffer.size})`,
    );
  }
  return byteLength;
}
