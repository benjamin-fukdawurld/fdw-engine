import type {
  GpuCommandEncoder,
  GpuPassTimer,
  PassTimes,
} from '@fdw/engine-backend';
import {
  Commands,
  ContextHandle,
  QueryPoolHandle,
  VulkanAddon,
} from '../addon';

// Sets of queries in flight: a frame starting while all are waiting for
// the GPU is not measured.
const Slots = 3;

interface Slot {
  // The first query of the slot in the pool.
  readonly first: number;
  state: 'free' | 'recording' | 'pending';
  frame: number;
  used: number;
}

// What the timer writes the commands with.
interface Writer {
  word(value: number): unknown;
}

/**
 * The pass timer of Vulkan: a timestamp before and after each measured
 * pass, outside of it, in a pool of queries reset at the first measure of
 * a frame; read without waiting once the GPU made them available.
 */
export class VulkanPassTimer implements GpuPassTimer {
  private readonly _pool: QueryPoolHandle;
  private readonly _id: number;
  private readonly _slots: Slot[];
  private readonly _stamps: Float64Array;
  private _recording?: Slot;
  private _latest?: PassTimes;

  constructor(
    private readonly _addon: VulkanAddon,
    context: ContextHandle,
    readonly capacity: number,
  ) {
    this._pool = _addon.createQueryPool(context, Slots * capacity * 2);
    this._id = _addon.queryPoolId(this._pool);
    this._slots = Array.from({ length: Slots }, (_, i) => ({
      first: i * capacity * 2,
      state: 'free' as const,
      frame: -1,
      used: 0,
    }));
    this._stamps = new Float64Array(capacity * 2);
  }

  /**
   * Writes the timestamp of the beginning (or the end) of the pass of slot
   * `index`: false when every set of queries is in flight.
   */
  write(writer: Writer, index: number, end: boolean): boolean {
    if (!this._recording) {
      const slot = this._slots.find((candidate) => candidate.state === 'free');
      if (!slot) {
        return false;
      }
      slot.state = 'recording';
      slot.used = 0;
      this._recording = slot;
      writer.word(Commands.resetQueries);
      writer.word(this._id);
      writer.word(slot.first);
      writer.word(this.capacity * 2);
    }
    const slot = this._recording;
    slot.used = Math.max(slot.used, index + 1);
    writer.word(Commands.writeTimestamp);
    writer.word(this._id);
    writer.word(slot.first + index * 2 + (end ? 1 : 0));
    return true;
  }

  resolve(_encoder: GpuCommandEncoder, frame: number): void {
    // The timestamps were written with the passes.
    const slot = this._recording;
    this._recording = undefined;
    if (slot) {
      slot.state = 'pending';
      slot.frame = frame;
    }
  }

  read(): PassTimes | undefined {
    for (const slot of this._slots) {
      if (
        slot.state !== 'pending' ||
        !this._addon.readQueryPool(
          this._pool,
          slot.first,
          slot.used * 2,
          this._stamps,
        )
      ) {
        continue;
      }
      slot.state = 'free';
      const durations = new Float64Array(this.capacity).fill(NaN);
      for (let i = 0; i < slot.used; i++) {
        const begin = this._stamps[i * 2];
        const end = this._stamps[i * 2 + 1];
        if (end >= begin) {
          durations[i] = (end - begin) / 1e6;
        }
      }
      if (!this._latest || slot.frame > this._latest.frame) {
        this._latest = { frame: slot.frame, durations };
      }
    }
    return this._latest;
  }

  destroy(): void {
    this._addon.destroyQueryPool(this._pool);
  }
}
