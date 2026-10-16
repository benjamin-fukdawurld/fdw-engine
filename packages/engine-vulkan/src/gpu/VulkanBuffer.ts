import type {
  GpuBuffer,
  GpuBufferFactory,
  GpuBufferUpdateFrequency,
  GpuBufferUsage,
} from '@fdw/engine-backend';
import {
  BufferHandle,
  BufferUsageFlags,
  ContextHandle,
  VulkanAddon,
} from '../addon';

// Resolves on the next turn of the event loop: polls the GPU without
// blocking Node.
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * A buffer in GPU memory. Writes follow queue.writeBuffer of WebGPU: copied
 * at once, applied in the order of the queue, before the commands submitted
 * next. Reads wait for everything submitted before.
 */
export class VulkanBuffer implements GpuBuffer {
  // Identifies the buffer in the commands.
  readonly id: number;
  private _handle?: BufferHandle;

  constructor(
    private readonly _addon: VulkanAddon,
    private readonly _context: ContextHandle,
    readonly size: number,
    readonly usage: readonly GpuBufferUsage[],
    readonly label?: string,
  ) {
    this._handle = _addon.createBuffer(
      _context,
      size,
      usage.reduce((flags, name) => flags | BufferUsageFlags[name], 0),
      label,
    );
    this.id = _addon.bufferId(this._handle);
  }

  /** The addon handle, for the other objects of the backend. */
  get handle(): BufferHandle {
    if (!this._handle) {
      throw new Error(`Buffer "${this.label ?? '(unlabeled)'}" was destroyed`);
    }
    return this._handle;
  }

  write(
    offset: number,
    value: ArrayBuffer,
    dataOffset = 0,
    size = value.byteLength - dataOffset,
  ): void {
    this._addon.writeBuffer(
      this.handle,
      offset,
      new Uint8Array(value, dataOffset, size),
    );
  }

  async read(offset = 0, size = this.size - offset): Promise<ArrayBuffer> {
    const ticket = this._addon.readBuffer(this.handle, offset, size);
    while (!this._addon.readReady(this._context, ticket)) {
      await nextTurn();
    }
    const data = new ArrayBuffer(size);
    this._addon.readTake(this._context, ticket, new Uint8Array(data));
    return data;
  }

  destroy(): void {
    if (this._handle) {
      // Freed once the GPU no longer uses it.
      this._addon.destroyBuffer(this._handle);
      this._handle = undefined;
    }
  }
}

export class VulkanBufferFactory implements GpuBufferFactory {
  constructor(
    private readonly _addon: VulkanAddon,
    private readonly _context: ContextHandle,
  ) {}

  create({
    size,
    usage,
    label,
    initialData,
  }: {
    size: number;
    usage: readonly GpuBufferUsage[];
    label?: string;
    initialData?: ArrayBufferView<ArrayBuffer>;
    updateFrequency?: GpuBufferUpdateFrequency;
  }): VulkanBuffer {
    const buffer = new VulkanBuffer(
      this._addon,
      this._context,
      size,
      usage,
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
