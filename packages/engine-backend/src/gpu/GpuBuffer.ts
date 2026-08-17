export type GpuBufferUsage =
  | 'uniform'
  | 'storage'
  | 'vertex'
  | 'index'
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
    size?: number
  ): void;

  destroy(): void;
}

export interface GpuBufferFactory {
  create(params: {
    size: number;
    usage: readonly GpuBufferUsage[];
    label?: string;
    initialData?: ArrayBuffer | ArrayBufferView;
    updateFrequency?: GpuBufferUpdateFrequency;
  }): GpuBuffer;
}
