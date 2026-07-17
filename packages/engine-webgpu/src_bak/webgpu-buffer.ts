import type {
  GpuBuffer,
  GpuBufferDescriptor,
  BufferUsage,
} from '@fdw/engine-backend';

/**
 * WebGPU implementation of {@link GpuBuffer}.
 *
 * Wraps a native `GPUBuffer` and automatically adds `COPY_DST` usage
 * so that data can be uploaded via {@link write}.
 */
export class WebGpuBuffer implements GpuBuffer {
  readonly label: string;
  readonly size: number;
  readonly usage: BufferUsage;

  _native: GPUBuffer;
  private _device: GPUDevice;

  constructor(device: GPUDevice, descriptor: GpuBufferDescriptor) {
    this._device = device;
    this.label = descriptor.label ?? '';
    this.size = descriptor.size;
    this.usage = descriptor.usage;

    this._native = device.createBuffer({
      label: this.label,
      size: descriptor.size,
      usage: descriptor.usage | GPUBufferUsage.COPY_DST,
      mappedAtCreation: descriptor.mappedAtCreation ?? false,
    });
  }

  /**
   * Uploads data to the buffer via the device queue.
   *
   * @param data - Typed array view containing the data to upload.
   * @param offset - Byte offset into the GPU buffer to write at.
   */
  write(data: ArrayBufferView, offset = 0): void {
    this._device.queue.writeBuffer(
      this._native,
      offset,
      data.buffer,
      data.byteOffset,
      data.byteLength,
    );
  }

  /** Destroys the underlying GPU buffer. */
  destroy(): void {
    this._native.destroy();
  }
}
