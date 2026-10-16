import { ResourceError } from '@fdw/engine-resources';

/** What the pool needs of a `Worker`: also satisfied by test doubles. */
export interface PoolWorker {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: any) => void): void;
}

export interface WorkerPoolOptions {
  create(): PoolWorker;
  /** Workers at most; they start when needed. Defaults to cores - 1, between 1 and 4. */
  readonly size?: number;
}

export interface RunOptions<R> {
  readonly transfer?: Transferable[];
  readonly signal?: AbortSignal;
  /** Frees a result nobody waits for any more (an `ImageBitmap`). */
  discard?(result: R): void;
}

interface Job {
  readonly resolve: (value: any) => void;
  readonly reject: (error: unknown) => void;
  readonly discard?: (result: any) => void;
  settled: boolean;
  cleanup?: () => void;
}

interface Slot {
  worker?: PoolWorker;
  readonly jobs: Map<number, Job>;
}

const defaultSize = () => {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 0;
  return Math.max(1, Math.min(4, (cores || 2) - 1));
};

/**
 * A few workers, spread by load. The protocol is `{ id, payload }` in and
 * `{ id, result }` or `{ id, error }` out: `serveWorker` is the other side.
 */
export class WorkerPool {
  private readonly slots: Slot[];
  private nextId = 1;
  private terminated = false;

  constructor(private readonly options: WorkerPoolOptions) {
    const size = Math.max(1, options.size ?? defaultSize());
    this.slots = Array.from({ length: size }, () => ({ jobs: new Map() }));
  }

  run<R = unknown>(payload: unknown, options: RunOptions<R> = {}): Promise<R> {
    if (this.terminated) return Promise.reject(new ResourceError('aborted', 'worker pool', 'The pool is terminated'));
    const { signal, transfer, discard } = options;
    if (signal?.aborted) return Promise.reject(new ResourceError('aborted', 'worker pool'));

    // The least busy worker; ties go to the first, so idle ones are not started.
    const slot = this.slots.reduce((best, s) => (s.jobs.size < best.jobs.size ? s : best));
    const worker = (slot.worker ??= this.spawn(slot));
    const id = this.nextId++;

    return new Promise<R>((resolve, reject) => {
      const job: Job = { resolve, reject, discard, settled: false };
      if (signal) {
        const onAbort = () => {
          // The worker keeps going (it cannot be interrupted): its result is
          // dropped when it arrives.
          if (job.settled) return;
          job.settled = true;
          reject(new ResourceError('aborted', 'worker pool'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        job.cleanup = () => signal.removeEventListener('abort', onAbort);
      }
      slot.jobs.set(id, job);
      try {
        worker.postMessage({ id, payload }, transfer);
      } catch (e) {
        slot.jobs.delete(id);
        job.cleanup?.();
        reject(new ResourceError('io', 'worker pool', 'Cannot post to the worker', { cause: e }));
      }
    });
  }

  terminate(): void {
    this.terminated = true;
    for (const slot of this.slots) this.drop(slot, new ResourceError('aborted', 'worker pool', 'The pool is terminated'));
  }

  private spawn(slot: Slot): PoolWorker {
    const worker = this.options.create();
    worker.addEventListener('message', (event: MessageEvent) => {
      const { id, result, error } = event.data ?? {};
      const job = slot.jobs.get(id);
      if (!job) return;
      slot.jobs.delete(id);
      job.cleanup?.();
      if (job.settled) {
        // Aborted in the meantime.
        if (!error) job.discard?.(result);
        return;
      }
      job.settled = true;
      if (error) {
        const e = new Error(error.message);
        e.name = error.name ?? 'Error';
        job.reject(new ResourceError('decode', 'worker pool', error.message, { cause: e }));
      } else job.resolve(result);
    });
    // A crashed worker takes its jobs with it; the next job starts a new one.
    worker.addEventListener('error', (event: ErrorEvent) => {
      this.drop(slot, new ResourceError('io', 'worker pool', `Worker failed: ${event.message ?? 'unknown error'}`));
    });
    return worker;
  }

  private drop(slot: Slot, reason: ResourceError): void {
    const worker = slot.worker;
    slot.worker = undefined;
    worker?.terminate();
    const jobs = [...slot.jobs.values()];
    slot.jobs.clear();
    for (const job of jobs) {
      job.cleanup?.();
      if (!job.settled) {
        job.settled = true;
        job.reject(reason);
      }
    }
  }
}

// --- The worker side --------------------------------------------------------

export interface WorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  postMessage(message: unknown, transfer: Transferable[]): void;
}

export interface WorkerResult<O> {
  readonly result: O;
  readonly transfer?: Transferable[];
}

/** Answers the messages of a `WorkerPool`. Call it from the worker script. */
export function serveWorker<I, O>(
  handler: (payload: I) => WorkerResult<O> | Promise<WorkerResult<O>>,
  scope: WorkerScope = globalThis as unknown as WorkerScope
): void {
  scope.addEventListener('message', async (event: MessageEvent) => {
    const { id, payload } = event.data as { id: number; payload: I };
    try {
      const { result, transfer } = await handler(payload);
      scope.postMessage({ id, result }, transfer ?? []);
    } catch (e) {
      const error = e instanceof Error ? { name: e.name, message: e.message } : { name: 'Error', message: String(e) };
      scope.postMessage({ id, error }, []);
    }
  });
}
