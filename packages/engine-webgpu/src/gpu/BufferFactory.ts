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
    ['indirect', GPUBufferUsage.INDIRECT],
  ];
}

function webGpuBufferUsageToFdEngine(
  usage: GPUBufferUsageFlags,
): GpuBufferUsage[] {
  return usageFlags()
    .filter(([, flag]) => (usage & flag) !== 0)
    .map(([name]) => name);
}

function fdEngineBufferUsageToWebGpu(
  usage: readonly GpuBufferUsage[],
): GPUBufferUsageFlags {
  return usageFlags()
    .filter(([name]) => usage.includes(name))
    .reduce((acc, [, flag]) => acc | flag, 0);
}

function padData(
  data: ArrayBuffer,
  dataOffset: number | undefined,
  byteLength: number,
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
    size?: number,
  ): void {
    if ((this.buffer.usage & GPUBufferUsage.COPY_DST) === 0) {
      throw new Error(
        `Buffer "${
          this.label ?? '(unlabeled)'
        }" was not created with 'copy-dst' usage and cannot be written to after creation.`,
      );
    }

    if (offset % 4 !== 0) {
      throw new Error(`Write offset must be a multiple of 4 (got ${offset})`);
    }

    const byteLength = size ?? value.byteLength - (dataOffset ?? 0);
    if ((dataOffset ?? 0) + byteLength > value.byteLength) {
      throw new Error(
        `Write of ${byteLength} bytes from offset ${
          dataOffset ?? 0
        } exceeds source data size ${value.byteLength}`,
      );
    }
    if (offset + byteLength > this.size) {
      throw new Error(
        `Write of ${byteLength} bytes at ${offset} exceeds buffer size ${this.size}`,
      );
    }

    if (byteLength % 4 === 0) {
      this.device.queue.writeBuffer(
        this.buffer,
        offset,
        value,
        dataOffset,
        byteLength,
      );
      return;
    }

    const padded = padData(value, dataOffset, byteLength);
    this.device.queue.writeBuffer(this.buffer, offset, padded);
  }

  async read(offset = 0, size = this.size - offset): Promise<ArrayBuffer> {
    if ((this.buffer.usage & GPUBufferUsage.COPY_SRC) === 0) {
      throw new Error(
        `Buffer "${
          this.label ?? '(unlabeled)'
        }" was not created with 'copy-src' usage and cannot be read back.`,
      );
    }
    // Copies are made by 4 bytes: the staging buffer covers the aligned range.
    const start = Math.floor(offset / 4) * 4;
    const end = Math.ceil((offset + size) / 4) * 4;
    const staging = this.device.createBuffer({
      label: `${this.label ?? 'buffer'} read back`,
      size: end - start,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.buffer, start, staging, 0, end - start);
    this.device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const data = staging
      .getMappedRange()
      .slice(offset - start, offset - start + size);
    staging.unmap();
    staging.destroy();
    return data;
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
        `Initial data size (${initialData.byteLength}) does not match the buffer size (${size}).`,
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
          initialData.byteLength,
        ),
      );
      buffer.unmap();
    } else {
      // Pass the underlying ArrayBuffer so that dataOffset and size are
      // interpreted in bytes, not in elements of the typed array.
      result.write(
        0,
        initialData.buffer,
        initialData.byteOffset,
        initialData.byteLength,
      );
    }

    return result;
  }
}
