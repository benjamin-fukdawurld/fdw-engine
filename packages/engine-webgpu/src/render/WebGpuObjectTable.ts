import type {
  GpuObjectTable,
  ObjectTableDescriptor,
} from '@fdw/engine-backend';

/**
 * The object table of WebGPU: two read-only storage buffers, the rows and
 * the row of each instance, bound at two consecutive bindings.
 */
export class WebGpuObjectTable implements GpuObjectTable {
  readonly rows: number;
  readonly instances: number;
  readonly rowBuffer: GPUBuffer;
  readonly instanceBuffer: GPUBuffer;
  private readonly _rowStride: number;

  constructor(
    private readonly _device: GPUDevice,
    { rows, instances, rowStride, label }: ObjectTableDescriptor,
  ) {
    this.rows = Math.max(rows, 1);
    this.instances = Math.max(instances, 1);
    this._rowStride = rowStride;
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    this.rowBuffer = _device.createBuffer({
      label: `${label ?? 'object table'} rows`,
      size: this.rows * rowStride,
      usage,
    });
    this.instanceBuffer = _device.createBuffer({
      label: `${label ?? 'object table'} instances`,
      size: this.instances * 4,
      usage,
    });
  }

  writeRows(firstRow: number, data: ArrayBufferView<ArrayBuffer>): void {
    this._device.queue.writeBuffer(
      this.rowBuffer,
      firstRow * this._rowStride,
      data.buffer,
      data.byteOffset,
      data.byteLength,
    );
  }

  writeInstances(firstInstance: number, rows: Uint32Array<ArrayBuffer>): void {
    this._device.queue.writeBuffer(
      this.instanceBuffer,
      firstInstance * 4,
      rows.buffer,
      rows.byteOffset,
      rows.byteLength,
    );
  }

  destroy(): void {
    this.rowBuffer.destroy();
    this.instanceBuffer.destroy();
  }
}
