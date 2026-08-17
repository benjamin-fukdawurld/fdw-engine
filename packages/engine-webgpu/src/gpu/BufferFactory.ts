import {
  GpuBuffer as FdGpuBuffer,
  GpuBufferFactory,
  GpuBufferUpdateFrequency,
  GpuBufferUsage,
} from '@fdw/engine-backend';

function webGpuBufferUsageToFdEngine(
  in_usage: GPUBufferUsageFlags
): GpuBufferUsage[] {
  return (
    [
      ['index', GPUBufferUsage.INDEX],
      ['copy-src', GPUBufferUsage.COPY_SRC],
      ['copy-dst', GPUBufferUsage.COPY_DST],
      ['uniform', GPUBufferUsage.UNIFORM],
      ['storage', GPUBufferUsage.STORAGE],
      ['vertex', GPUBufferUsage.VERTEX],
    ] as [GpuBufferUsage, GPUBufferUsageFlags][]
  )
    .filter(([, usage]) => (in_usage & usage) !== 0)
    .map(([name]) => name as GpuBufferUsage);
}

function fdEngineBufferUsageToWebGpu(
  in_usage: readonly GpuBufferUsage[]
): GPUBufferUsageFlags {
  return (
    [
      ['index', GPUBufferUsage.INDEX],
      ['copy-src', GPUBufferUsage.COPY_SRC],
      ['copy-dst', GPUBufferUsage.COPY_DST],
      ['uniform', GPUBufferUsage.UNIFORM],
      ['storage', GPUBufferUsage.STORAGE],
      ['vertex', GPUBufferUsage.VERTEX],
    ] as [GpuBufferUsage, GPUBufferUsageFlags][]
  )
    .filter(([name]) => in_usage.includes(name))
    .reduce((acc, [, usageFlag]) => acc | usageFlag, 0);
}

export class Buffer implements FdGpuBuffer {
  device: GPUDevice;
  buffer: GPUBuffer;

  constructor(device: GPUDevice, buffer: GPUBuffer) {
    this.device = device;
    this.buffer = buffer;
  }

  get size(): number {
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

    this.device.queue.writeBuffer(this.buffer, offset, value, dataOffset, size);
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
    initialData?: ArrayBuffer | ArrayBufferView;
    updateFrequency?: GpuBufferUpdateFrequency;
  }): Buffer {
    if (size < 1) {
      throw new Error('Size must be greater than 0');
    }

    const gpuUsage = fdEngineBufferUsageToWebGpu(usage);

    const mappedAtCreation =
      initialData !== undefined &&
      (!usage.includes('copy-dst') || updateFrequency === 'static');

    const buffer = this.device.createBuffer({
      size,
      usage: gpuUsage,
      mappedAtCreation,
      label,
    });

    if (initialData === undefined) {
      return new Buffer(this.device, buffer);
    }

    if (mappedAtCreation) {
      const dst = new Uint8Array(buffer.getMappedRange());
      const src =
        initialData instanceof ArrayBuffer
          ? new Uint8Array(initialData)
          : new Uint8Array(
              initialData.buffer,
              initialData.byteOffset,
              initialData.byteLength
            );
      dst.set(src);
      buffer.unmap();
    } else {
      this.device.queue.writeBuffer(buffer, 0, initialData as BufferSource);
    }

    return new Buffer(this.device, buffer);
  }
}
