import type {
  GpuCommandEncoder,
  GpuPassTimer,
  PassTimes,
} from '@fdw/engine-backend';

// Read back buffers in flight: a frame resolved while all are waiting for
// the GPU is not measured.
const Slots = 3;

interface Slot {
  readonly buffer: GPUBuffer;
  state: 'free' | 'resolved' | 'mapping';
  frame: number;
  // The slots measured in the frame: the others are NaN.
  used: number;
}

/**
 * The pass timer of WebGPU: two timestamps per pass (`timestampWrites`, the
 * only timestamps of core WebGPU), resolved into a buffer after the passes,
 * copied to a read back buffer, mapped once submitted.
 */
export class WebGpuPassTimer implements GpuPassTimer {
  private readonly _querySet: GPUQuerySet;
  private readonly _resolved: GPUBuffer;
  private readonly _slots: Slot[];
  private _used = 0;
  private _latest?: PassTimes;
  private _destroyed = false;

  constructor(device: GPUDevice, readonly capacity: number) {
    this._querySet = device.createQuerySet({
      label: 'pass timer',
      type: 'timestamp',
      count: capacity * 2,
    });
    // Timestamps are 64-bit integers, in nanoseconds.
    const size = capacity * 2 * 8;
    this._resolved = device.createBuffer({
      label: 'pass timer resolve',
      size,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    this._slots = Array.from({ length: Slots }, (_, i) => ({
      buffer: device.createBuffer({
        label: `pass timer read back ${i}`,
        size,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      }),
      state: 'free' as const,
      frame: -1,
      used: 0,
    }));
  }

  /** The timestamp writes of the pass of slot `index`. */
  timestampWrites(index: number): GPURenderPassTimestampWrites {
    this._used = Math.max(this._used, index + 1);
    return {
      querySet: this._querySet,
      beginningOfPassWriteIndex: index * 2,
      endOfPassWriteIndex: index * 2 + 1,
    };
  }

  resolve(encoder: GpuCommandEncoder, frame: number): void {
    const used = this._used;
    this._used = 0;
    const slot = this._slots.find((candidate) => candidate.state === 'free');
    if (!slot || used === 0) {
      return;
    }
    const target = encoder as {
      gpu?: GPUCommandEncoder;
      timers?: Set<WebGpuPassTimer>;
    };
    const gpu = target.gpu;
    if (!gpu || !target.timers) {
      throw new Error('The command encoder was not created by WebGPU');
    }
    // The backend calls submitted() once the commands are submitted.
    target.timers.add(this);
    gpu.resolveQuerySet(this._querySet, 0, used * 2, this._resolved, 0);
    gpu.copyBufferToBuffer(this._resolved, 0, slot.buffer, 0, used * 2 * 8);
    slot.state = 'resolved';
    slot.frame = frame;
    slot.used = used;
  }

  /**
   * After the submission of the commands holding the resolves: maps the read
   * back buffers (mapping before would invalidate the submission).
   */
  submitted(): void {
    for (const slot of this._slots) {
      if (slot.state !== 'resolved') {
        continue;
      }
      slot.state = 'mapping';
      slot.buffer.mapAsync(GPUMapMode.READ).then(
        () => {
          if (this._destroyed) {
            return;
          }
          const stamps = new BigInt64Array(slot.buffer.getMappedRange());
          const durations = new Float64Array(this.capacity).fill(NaN);
          for (let i = 0; i < slot.used; i++) {
            const begin = stamps[i * 2];
            const end = stamps[i * 2 + 1];
            if (end >= begin && begin > 0n) {
              durations[i] = Number(end - begin) / 1e6;
            }
          }
          slot.buffer.unmap();
          if (!this._latest || slot.frame > this._latest.frame) {
            this._latest = { frame: slot.frame, durations };
          }
          slot.state = 'free';
        },
        () => {
          // The device was lost or the timer destroyed.
          slot.state = 'free';
        }
      );
    }
  }

  read(): PassTimes | undefined {
    return this._latest;
  }

  destroy(): void {
    this._destroyed = true;
    this._querySet.destroy();
    this._resolved.destroy();
    for (const slot of this._slots) {
      slot.buffer.destroy();
    }
  }
}
