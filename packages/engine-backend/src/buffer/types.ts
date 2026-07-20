export const SupportedBufferTypeNames = ['mat3', 'mat4'] as const;
export type SupportedBufferTypeName = (typeof SupportedBufferTypeNames)[number];
export type BufferTypeName = SupportedBufferTypeName | (string & {});

export type BufferedValue<T, TBuffer = unknown> = {
  buffer: TBuffer;
  type: BufferTypeName;
  //cached: CachedValue<T>;
};

export type CreateBufferStrategy<TBuffer = unknown> = (
  type: BufferTypeName,
  options?: unknown
) => TBuffer;

export type WriteBufferStrategy<TBuffer = unknown, TData = unknown> = (
  buffer: TBuffer,
  type: BufferTypeName,
  data: TData,
  options?: unknown
) => void;

export type BufferedValueAdapter<TData, TBuffer = unknown> = {
  value: BufferedValue<TData, TBuffer>;
  createBuffer: CreateBufferStrategy<TBuffer>;
  writeBuffer: WriteBufferStrategy<TBuffer, TData>;
};
