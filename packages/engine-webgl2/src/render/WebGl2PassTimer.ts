import type {
  GpuCommandEncoder,
  GpuPassTimer,
  PassTimes,
} from '@fdw/engine-backend';

// The extension of the timer queries (WebGL2), when the browser gives it.
export interface TimerQueryExtension {
  readonly TIME_ELAPSED_EXT: GLenum;
  readonly GPU_DISJOINT_EXT: GLenum;
}

// Sets of queries in flight: a frame starting while all are waiting for
// the GPU is not measured.
const Slots = 3;

interface Slot {
  readonly queries: WebGLQuery[];
  state: 'free' | 'recording' | 'pending';
  frame: number;
  used: number;
}

/**
 * The pass timer of WebGL2: a TIME_ELAPSED query around each measured pass
 * (`EXT_disjoint_timer_query_webgl2`), read when the GPU makes the results
 * available. A frame during which the GPU was disjoint (its clock changed)
 * is dropped.
 */
export class WebGl2PassTimer implements GpuPassTimer {
  private readonly _slots: Slot[];
  private _recording?: Slot;
  private _latest?: PassTimes;

  constructor(
    private readonly _gl: WebGL2RenderingContext,
    private readonly _extension: TimerQueryExtension,
    readonly capacity: number,
  ) {
    this._slots = Array.from({ length: Slots }, () => ({
      queries: Array.from({ length: capacity }, () => _gl.createQuery()),
      state: 'free' as const,
      frame: -1,
      used: 0,
    }));
  }

  /**
   * The query measuring the pass of slot `index` in the frame being
   * recorded; undefined when every set of queries is in flight.
   */
  query(index: number): WebGLQuery | undefined {
    if (!this._recording) {
      this._recording = this._slots.find((slot) => slot.state === 'free');
      if (!this._recording) {
        return undefined;
      }
      this._recording.state = 'recording';
      this._recording.used = 0;
    }
    this._recording.used = Math.max(this._recording.used, index + 1);
    return this._recording.queries[index];
  }

  /** The target of the queries. */
  get target(): GLenum {
    return this._extension.TIME_ELAPSED_EXT;
  }

  resolve(_encoder: GpuCommandEncoder, frame: number): void {
    // The queries were recorded by the passes: they run on submit.
    const slot = this._recording;
    this._recording = undefined;
    if (slot) {
      slot.state = 'pending';
      slot.frame = frame;
    }
  }

  read(): PassTimes | undefined {
    const gl = this._gl;
    for (const slot of this._slots) {
      if (slot.state !== 'pending') {
        continue;
      }
      const last = slot.queries[slot.used - 1];
      if (!gl.getQueryParameter(last, gl.QUERY_RESULT_AVAILABLE)) {
        continue;
      }
      slot.state = 'free';
      if (gl.getParameter(this._extension.GPU_DISJOINT_EXT)) {
        continue;
      }
      const durations = new Float64Array(this.capacity).fill(NaN);
      for (let i = 0; i < slot.used; i++) {
        // Nanoseconds.
        durations[i] =
          gl.getQueryParameter(slot.queries[i], gl.QUERY_RESULT) / 1e6;
      }
      if (!this._latest || slot.frame > this._latest.frame) {
        this._latest = { frame: slot.frame, durations };
      }
    }
    return this._latest;
  }

  destroy(): void {
    for (const slot of this._slots) {
      slot.queries.forEach((query) => this._gl.deleteQuery(query));
    }
  }
}
