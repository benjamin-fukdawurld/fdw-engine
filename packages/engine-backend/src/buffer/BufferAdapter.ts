import {
  BufferTypeName,
  CreateBufferStrategy,
  WriteBufferStrategy,
} from './types';

export class BufferAdapterRegistry<TBuffer = unknown> {
  private createBufferStrategies: Map<
    BufferTypeName,
    CreateBufferStrategy<TBuffer>
  >;
  private writeBufferStrategies: Map<
    BufferTypeName,
    WriteBufferStrategy<TBuffer, unknown>
  >;

  constructor(options: {
    createBufferStrategies:
      | Map<BufferTypeName, CreateBufferStrategy<TBuffer>>
      | Record<BufferTypeName, CreateBufferStrategy<TBuffer>>;
    writeBufferStrategies:
      | Map<BufferTypeName, WriteBufferStrategy<TBuffer, unknown>>
      | Record<BufferTypeName, WriteBufferStrategy<TBuffer, unknown>>;
  }) {
    this.createBufferStrategies =
      options.createBufferStrategies instanceof Map
        ? options.createBufferStrategies
        : new Map(
            Object.entries(options.createBufferStrategies) as [
              BufferTypeName,
              CreateBufferStrategy<TBuffer>
            ][]
          );
    this.writeBufferStrategies =
      options.writeBufferStrategies instanceof Map
        ? options.writeBufferStrategies
        : new Map(
            Object.entries(options.writeBufferStrategies) as [
              BufferTypeName,
              WriteBufferStrategy<TBuffer, unknown>
            ][]
          );
  }

  createBuffer(type: BufferTypeName, options?: unknown): TBuffer {
    const strategy = this.createBufferStrategies.get(type);
    if (!strategy) {
      throw new Error(`No create buffer strategy found for type: ${type}`);
    }
    return strategy(type, options);
  }

  writeBuffer<TData>(
    buffer: TBuffer,
    type: BufferTypeName,
    data: TData,
    options?: unknown
  ): void {
    const strategy = this.writeBufferStrategies.get(type);
    if (!strategy) {
      throw new Error(`No write buffer strategy found for type: ${type}`);
    }
    strategy(buffer, type, data, options);
  }
}
