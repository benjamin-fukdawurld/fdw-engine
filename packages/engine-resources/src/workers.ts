import { ResourceError } from './errors';

// The decoding in workers, seen from the decoders: they post jobs to a pool
// the application created (the `WorkerPool` of `-web` or of `-native`), and
// the worker script of the application serves their tasks. Nothing here
// knows a platform.

export interface DecodeRunOptions<R> {
  /** Buffers moved to the worker instead of copied: they become empty here. */
  readonly transfer?: ArrayBuffer[];
  readonly signal?: AbortSignal;
  /** Frees a result nobody waits for any more. */
  discard?(result: R): void;
}

/**
 * What the decoders need of a pool of workers: the `WorkerPool` of
 * `@fdw/engine-resources-web` and the one of `@fdw/engine-resources-native`
 * both fit, as does `createLocalPool`.
 */
export interface DecodePool {
  run<R>(payload: unknown, options?: DecodeRunOptions<R>): Promise<R>;
}

/** A job of a pool shared by several decoders: the name of its task, its input. */
export interface TaskMessage {
  readonly task: string;
  readonly input: unknown;
}

export interface TaskOutput<O> {
  readonly result: O;
  /** The buffers (bitmaps) of the result, moved back instead of copied. */
  readonly transfer?: Transferable[];
}

export type WorkerTask<I = any, O = any> = (
  input: I,
) => TaskOutput<O> | Promise<TaskOutput<O>>;

/** Tasks by name (`gltf/primitive`, `ktx2/transcode`): what a worker script serves. */
export type WorkerTasks = Readonly<Record<string, WorkerTask>>;

/** Runs a task of the worker script in a worker of the pool. */
export function runTask<R>(
  pool: DecodePool,
  task: string,
  input: unknown,
  options?: DecodeRunOptions<R>,
): Promise<R> {
  const message: TaskMessage = { task, input };
  return pool.run<R>(message, options);
}

/**
 * The handler of `serveWorker` for a worker serving tasks by name, those of
 * several packages in one script:
 *
 * ```ts
 * serveWorker(taskHandler({ ...imageWorkerTasks(), ...gltfWorkerTasks({ meshopt }) }));
 * ```
 */
export function taskHandler(
  tasks: WorkerTasks,
): (
  message: TaskMessage,
) => Promise<{ readonly result: unknown; readonly transfer?: any[] }> {
  // `any[]`: the transfer lists of the browser and of Node are both accepted.
  return async ({ task, input }) => {
    if (!Object.hasOwn(tasks, task))
      throw new Error(`This worker has no task ${task}`);
    return tasks[task](input);
  };
}

/**
 * The view alone over its buffer, so that moving the buffer moves nothing
 * else: the view itself, or a copy when it is a part of a larger buffer (a
 * file, the memory of a WASM module).
 */
export function owned<T extends ArrayBufferView>(view: T): T {
  if (
    view.buffer instanceof ArrayBuffer &&
    view.byteOffset === 0 &&
    view.byteLength === view.buffer.byteLength
  )
    return view;
  return (view as unknown as { slice(): T }).slice();
}

/** The distinct buffers of views, for `transfer`: a buffer listed twice fails the post. */
export function buffersOf(
  views: Iterable<ArrayBufferView | undefined>,
): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const view of views)
    if (view?.buffer instanceof ArrayBuffer) buffers.add(view.buffer);
  return [...buffers];
}

/**
 * A pool without workers: the tasks run on the calling thread, their input
 * and result cloned as `postMessage` would (the transferred buffers
 * emptied), so a decoder behaves as with real workers. For the tests, and
 * the platforms without workers.
 */
export function createLocalPool(tasks: WorkerTasks): DecodePool {
  const handler = taskHandler(tasks);
  return {
    async run<R>(
      payload: unknown,
      { transfer = [], signal, discard }: DecodeRunOptions<R> = {},
    ): Promise<R> {
      if (signal?.aborted) throw new ResourceError('aborted', 'worker pool');
      const message = structuredClone(payload, { transfer }) as TaskMessage;
      let output: TaskOutput<R>;
      try {
        output = (await handler(message)) as TaskOutput<R>;
      } catch (e) {
        throw new ResourceError(
          'decode',
          'worker pool',
          e instanceof Error ? e.message : String(e),
          { cause: e },
        );
      }
      const result = structuredClone(output.result, {
        transfer: output.transfer ?? [],
      });
      if (signal?.aborted) {
        discard?.(result);
        throw new ResourceError('aborted', 'worker pool');
      }
      return result;
    },
  };
}
