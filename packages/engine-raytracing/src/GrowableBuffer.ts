import type {
  GpuBuffer,
  GpuBufferUsage,
  RenderBackend,
} from '@fdw/engine-backend';

/**
 * A storage buffer of fixed size units, allocated first fit, growing by
 * copying into a larger one: its `version` then changes (the bind groups
 * holding it must be made again).
 */
export class GrowableBuffer {
  private _buffer: GpuBuffer;
  private _capacity: number;
  private _version = 0;
  // Free ranges [start, count], sorted by start.
  private _free: [number, number][];

  constructor(
    private readonly backend: RenderBackend,
    private readonly unitBytes: number,
    capacity: number,
    private readonly label: string,
    private readonly usage: readonly GpuBufferUsage[] = [
      'storage',
      'copy-dst',
      'copy-src',
    ],
  ) {
    this._capacity = Math.max(1, capacity);
    this._free = [[0, this._capacity]];
    this._buffer = this.create(this._capacity);
  }

  get buffer(): GpuBuffer {
    return this._buffer;
  }

  get version(): number {
    return this._version;
  }

  /** The units in use: the capacity less the free ones. */
  get used(): number {
    return this._free.reduce((left, [, count]) => left - count, this._capacity);
  }

  /** The first of `count` free units, the buffer grown if needed. */
  allocate(count: number): number {
    if (count === 0) {
      return 0;
    }
    for (let i = 0; i < this._free.length; i++) {
      const [start, size] = this._free[i];
      if (size >= count) {
        if (size === count) {
          this._free.splice(i, 1);
        } else {
          this._free[i] = [start + count, size - count];
        }
        return start;
      }
    }
    this.grow(count);
    return this.allocate(count);
  }

  release(start: number, count: number): void {
    if (count === 0) {
      return;
    }
    let i = 0;
    while (i < this._free.length && this._free[i][0] < start) {
      i++;
    }
    this._free.splice(i, 0, [start, count]);
    for (const at of [i, i - 1]) {
      const current = this._free[at];
      const next = this._free[at + 1];
      if (current && next && current[0] + current[1] === next[0]) {
        current[1] += next[1];
        this._free.splice(at + 1, 1);
      }
    }
  }

  /** Writes units from `unit`, in the order of the queue. */
  write(unit: number, data: ArrayBufferView<ArrayBuffer>): void {
    if (data.byteLength > 0) {
      this._buffer.write(
        unit * this.unitBytes,
        data.buffer,
        data.byteOffset,
        data.byteLength,
      );
    }
  }

  destroy(): void {
    this._buffer.destroy();
  }

  private create(capacity: number): GpuBuffer {
    return this.backend.buffers.create({
      label: this.label,
      size: capacity * this.unitBytes,
      usage: this.usage,
    });
  }

  private grow(count: number): void {
    const capacity = Math.max(this._capacity * 2, this._capacity + count);
    const buffer = this.create(capacity);
    const encoder = this.backend.createCommandEncoder();
    encoder.copyBufferToBuffer(
      this._buffer,
      0,
      buffer,
      0,
      this._capacity * this.unitBytes,
    );
    this.backend.submit([encoder.finish()]);
    // Freed once the commands using it are done.
    this._buffer.destroy();
    this._buffer = buffer;
    const last = this._free[this._free.length - 1];
    if (last && last[0] + last[1] === this._capacity) {
      last[1] += capacity - this._capacity;
    } else {
      this._free.push([this._capacity, capacity - this._capacity]);
    }
    this._capacity = capacity;
    this._version++;
  }
}
