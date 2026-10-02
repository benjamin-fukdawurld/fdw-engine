import {
  GpuBuffer as FdGpuBuffer,
  GpuBufferFactory,
  GpuBufferUpdateFrequency,
  GpuBufferUsage,
} from '@fdw/engine-backend';

// Function rather than constant: GPUBufferUsage only exists in a WebGPU
// context, so it must not be read when the module is loaded.
function usageFlags(): readonly [GpuBufferUsage, GPUBufferUsageFlags][] {
  return [
    ['index', GPUBufferUsage.INDEX],
    ['copy-src', GPUBufferUsage.COPY_SRC],
    ['copy-dst', GPUBufferUsage.COPY_DST],
    ['uniform', GPUBufferUsage.UNIFORM],
    ['storage', GPUBufferUsage.STORAGE],
    ['vertex', GPUBufferUsage.VERTEX],
  ];
}

function webGpuBufferUsageToFdEngine(
  usage: GPUBufferUsageFlags
): GpuBufferUsage[] {
  return usageFlags()
    .filter(([, flag]) => (usage & flag) !== 0)
    .map(([name]) => name);
}

function fdEngineBufferUsageToWebGpu(
  usage: readonly GpuBufferUsage[]
): GPUBufferUsageFlags {
  return usageFlags()
    .filter(([name]) => usage.includes(name))
    .reduce((acc, [, flag]) => acc | flag, 0);
}

function padData(
  data: ArrayBuffer,
  dataOffset: number | undefined,
  byteLength: number
): Uint8Array<ArrayBuffer> {
  const padded = new Uint8Array(Math.ceil(byteLength / 4) * 4);
  padded.set(new Uint8Array(data, dataOffset ?? 0, byteLength));
  return padded;
}

export class Buffer implements FdGpuBuffer {
  readonly device: GPUDevice;
  readonly buffer: GPUBuffer;
  private readonly _size: number;

  constructor({
    device,
    buffer,
    size,
  }: {
    device: GPUDevice;
    buffer: GPUBuffer;
    size: number;
  }) {
    this.device = device;
    this.buffer = buffer;
    this._size = size;
  }

  get size(): number {
    return this._size;
  }

  get allocatedSize(): number {
    return this.buffer.size;
  }

  get usage(): readonly GpuBufferUsage[] {
    return webGpuBufferUsageToFdEngine(this.buffer.usage);
  }

  get label(): string | undefined {
    return this.buffer.label;
  }

  write(
    offset: number,
    value: ArrayBuffer,
    dataOffset?: number,
    size?: number
  ): void {
    if ((this.buffer.usage & GPUBufferUsage.COPY_DST) === 0) {
      throw new Error(
        `Buffer "${
          this.label ?? '(unlabeled)'
        }" was not created with 'copy-dst' usage and cannot be written to after creation.`
      );
    }

    if (offset % 4 !== 0) {
      throw new Error(`Write offset must be a multiple of 4 (got ${offset})`);
    }

    const byteLength = size ?? value.byteLength - (dataOffset ?? 0);
    if ((dataOffset ?? 0) + byteLength > value.byteLength) {
      throw new Error(
        `Write of ${byteLength} bytes from offset ${dataOffset ?? 0} exceeds source data size ${value.byteLength}`
      );
    }
    if (offset + byteLength > this.size) {
      throw new Error(
        `Write of ${byteLength} bytes at ${offset} exceeds buffer size ${this.size}`
      );
    }

    if (byteLength % 4 === 0) {
      this.device.queue.writeBuffer(
        this.buffer,
        offset,
        value,
        dataOffset,
        byteLength
      );
      return;
    }

    const padded = padData(value, dataOffset, byteLength);
    this.device.queue.writeBuffer(this.buffer, offset, padded);
  }

  destroy(): void {
    this.buffer.destroy();
  }
}

export class BufferFactory implements GpuBufferFactory {
  public device: GPUDevice;

  constructor(device: GPUDevice) {
    this.device = device;
  }

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
  }): Buffer {
    if (size < 1) {
      throw new Error('Size must be greater than 0');
    }

    if (initialData && initialData.byteLength !== size) {
      throw new Error(
        `Initial data size (${initialData.byteLength}) does not match the buffer size (${size}).`
      );
    }

    const gpuUsage = fdEngineBufferUsageToWebGpu(usage);

    const mappedAtCreation =
      initialData !== undefined &&
      (!usage.includes('copy-dst') || updateFrequency === 'static');

    const paddedSize = Math.ceil(size / 4) * 4;

    const buffer = this.device.createBuffer({
      size: paddedSize,
      usage: gpuUsage,
      mappedAtCreation,
      label,
    });

    const result = new Buffer({ device: this.device, buffer, size });

    if (initialData === undefined) {
      return result;
    }

    if (mappedAtCreation) {
      new Uint8Array(buffer.getMappedRange()).set(
        new Uint8Array(
          initialData.buffer,
          initialData.byteOffset,
          initialData.byteLength
        )
      );
      buffer.unmap();
    } else {
      // Pass the underlying ArrayBuffer so that dataOffset and size are
      // interpreted in bytes, not in elements of the typed array.
      result.write(
        0,
        initialData.buffer,
        initialData.byteOffset,
        initialData.byteLength
      );
    }

    return result;
  }
}
