import { parentPort, Worker, type TransferListItem } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { ResourceError } from '@fdw/engine-resources';

export interface WorkerPoolOptions {
  /** The worker module: it calls `serveWorker`. */
  readonly url: URL;
  /** Workers at most; they start when needed. Defaults to cores - 1, between 1 and 4. */
  readonly size?: number;
}

export interface RunOptions<R> {
  readonly transfer?: readonly TransferListItem[];
  readonly signal?: AbortSignal;
  /** Frees a result nobody waits for any more. */
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
  worker?: Worker;
  readonly jobs: Map<number, Job>;
}

/**
 * A few `worker_threads`, spread by load: the same protocol as the
 * `WorkerPool` of `@fdw/engine-resources-web`, `{ id, payload }` in and
 * `{ id, result }` or `{ id, error }` out. `serveWorker` is the other side.
 * Idle workers do not keep the process alive.
 */
export class WorkerPool {
  private readonly slots: Slot[];
  private nextId = 1;
  private terminated = false;

  constructor(private readonly options: WorkerPoolOptions) {
    const size = Math.max(
      1,
      options.size ?? Math.min(4, availableParallelism() - 1)
    );
    this.slots = Array.from({ length: size }, () => ({ jobs: new Map() }));
  }

  run<R = unknown>(payload: unknown, options: RunOptions<R> = {}): Promise<R> {
    if (this.terminated) {
      return Promise.reject(
        new ResourceError('aborted', 'worker pool', 'The pool is terminated')
      );
    }
    const { signal, transfer, discard } = options;
    if (signal?.aborted)
      return Promise.reject(new ResourceError('aborted', 'worker pool'));

    const slot = this.slots.reduce((best, s) =>
      s.jobs.size < best.jobs.size ? s : best
    );
    const worker = (slot.worker ??= this.spawn(slot));
    const id = this.nextId++;

    return new Promise<R>((resolve, reject) => {
      const job: Job = { resolve, reject, discard, settled: false };
      if (signal) {
        // The worker keeps going: its result is dropped when it arrives.
        const onAbort = () => {
          if (job.settled) return;
          job.settled = true;
          reject(new ResourceError('aborted', 'worker pool'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        job.cleanup = () => signal.removeEventListener('abort', onAbort);
      }
      slot.jobs.set(id, job);
      worker.ref();
      try {
        worker.postMessage({ id, payload }, transfer);
      } catch (e) {
        this.finish(slot, id);
        job.cleanup?.();
        reject(
          new ResourceError('io', 'worker pool', 'Cannot post to the worker', {
            cause: e,
          })
        );
      }
    });
  }

  async terminate(): Promise<void> {
    this.terminated = true;
    await Promise.all(
      this.slots.map((slot) =>
        this.drop(
          slot,
          new ResourceError('aborted', 'worker pool', 'The pool is terminated')
        )
      )
    );
  }

  private spawn(slot: Slot): Worker {
    const worker = new Worker(this.options.url);
    worker.on(
      'message',
      ({
        id,
        result,
        error,
      }: {
        id: number;
        result?: unknown;
        error?: { name: string; message: string };
      }) => {
        const job = slot.jobs.get(id);
        if (!job) return;
        this.finish(slot, id);
        job.cleanup?.();
        if (job.settled) {
          if (!error) job.discard?.(result);
          return;
        }
        job.settled = true;
        if (error) {
          const cause = Object.assign(new Error(error.message), {
            name: error.name,
          });
          job.reject(
            new ResourceError('decode', 'worker pool', error.message, { cause })
          );
        } else job.resolve(result);
      }
    );
    // A crashed worker takes its jobs with it; the next job starts a new one.
    worker.on('error', (e) => {
      if (slot.worker !== worker) return;
      void this.drop(
        slot,
        new ResourceError('io', 'worker pool', `Worker failed: ${e.message}`, {
          cause: e,
        })
      );
    });
    worker.on('exit', (code) => {
      if (slot.worker !== worker) return;
      void this.drop(
        slot,
        new ResourceError(
          'io',
          'worker pool',
          `Worker exited with code ${code}`
        )
      );
    });
    worker.unref();
    return worker;
  }

  private finish(slot: Slot, id: number): void {
    slot.jobs.delete(id);
    if (slot.jobs.size === 0) slot.worker?.unref();
  }

  private async drop(slot: Slot, reason: ResourceError): Promise<void> {
    const worker = slot.worker;
    slot.worker = undefined;
    const jobs = [...slot.jobs.values()];
    slot.jobs.clear();
    for (const job of jobs) {
      job.cleanup?.();
      if (!job.settled) {
        job.settled = true;
        job.reject(reason);
      }
    }
    await worker?.terminate();
  }
}

export interface WorkerResult<O> {
  readonly result: O;
  readonly transfer?: readonly TransferListItem[];
}

/** Answers the messages of a `WorkerPool`. Call it from the worker module. */
export function serveWorker<I, O>(
  handler: (payload: I) => WorkerResult<O> | Promise<WorkerResult<O>>
): void {
  const port = parentPort;
  if (!port) throw new Error('serveWorker must be called from a worker thread');
  port.on('message', async ({ id, payload }: { id: number; payload: I }) => {
    try {
      const { result, transfer } = await handler(payload);
      port.postMessage({ id, result }, transfer);
    } catch (e) {
      const error =
        e instanceof Error
          ? { name: e.name, message: e.message }
          : { name: 'Error', message: String(e) };
      port.postMessage({ id, error });
    }
  });
}
