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
