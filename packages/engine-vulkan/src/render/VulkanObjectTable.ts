import type {
  GpuBufferFactory,
  GpuObjectTable,
  ObjectTableDescriptor,
} from '@fdw/engine-backend';
import { VulkanBuffer } from '../gpu/VulkanBuffer';

/**
 * The object table of Vulkan: two storage buffers, the rows and the row of
 * each instance, bound at two consecutive bindings.
 */
export class VulkanObjectTable implements GpuObjectTable {
  readonly rows: number;
  readonly instances: number;
  readonly rowBuffer: VulkanBuffer;
  readonly instanceBuffer: VulkanBuffer;
  private readonly _rowStride: number;

  constructor(
    buffers: GpuBufferFactory,
    { rows, instances, rowStride, label }: ObjectTableDescriptor
  ) {
    this.rows = Math.max(rows, 1);
    this.instances = Math.max(instances, 1);
    this._rowStride = rowStride;
    const create = (size: number, name: string) =>
      buffers.create({
        size,
        usage: ['storage', 'copy-dst'],
        label: `${label ?? 'object table'} ${name}`,
      }) as VulkanBuffer;
    this.rowBuffer = create(this.rows * rowStride, 'rows');
    this.instanceBuffer = create(this.instances * 4, 'instances');
  }

  writeRows(firstRow: number, data: ArrayBufferView<ArrayBuffer>): void {
    this.rowBuffer.write(
      firstRow * this._rowStride,
      data.buffer,
      data.byteOffset,
      data.byteLength
    );
  }

  writeInstances(firstInstance: number, rows: Uint32Array<ArrayBuffer>): void {
    this.instanceBuffer.write(
      firstInstance * 4,
      rows.buffer,
      rows.byteOffset,
      rows.byteLength
    );
  }

  destroy(): void {
    this.rowBuffer.destroy();
    this.instanceBuffer.destroy();
  }
}
