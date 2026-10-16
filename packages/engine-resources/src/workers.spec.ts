import { describe, expect, it, vi } from 'vitest';
import {
  buffersOf,
  createLocalPool,
  owned,
  runTask,
  taskHandler,
  type WorkerTasks,
} from './workers';

const tasks: WorkerTasks = {
  // Doubles the bytes, into a new buffer moved back.
  double: (bytes: Uint8Array) => {
    const out = bytes.map((b) => b * 2);
    return { result: out, transfer: [out.buffer] };
  },
  fail: () => {
    throw new RangeError('boom');
  },
  slow: async (n: number) => (
    await new Promise((r) => setTimeout(r, 5)),
    { result: n }
  ),
};

describe('worker tasks', () => {
  it('dispatches by name, and refuses an unknown task', async () => {
    const handle = taskHandler(tasks);
    expect((await handle({ task: 'slow', input: 3 })).result).toBe(3);
    await expect(
      handle({ task: 'toString', input: undefined }),
    ).rejects.toThrow('This worker has no task toString');
  });

  it('runs in a local pool as in a worker: inputs cloned, transfers moved', async () => {
    const pool = createLocalPool(tasks);
    const bytes = new Uint8Array([1, 2, 3]);
    const kept = new Uint8Array([4]);
    const moved = await runTask<Uint8Array>(pool, 'double', bytes, {
      transfer: [bytes.buffer],
    });
    expect([...moved]).toEqual([2, 4, 6]);
    expect(bytes.byteLength).toBe(0);
    expect([...(await runTask<Uint8Array>(pool, 'double', kept))]).toEqual([8]);
    expect(kept.byteLength).toBe(1); // copied
  });

  it('reports errors as decode, and drops the result of an aborted job', async () => {
    const pool = createLocalPool(tasks);
    await expect(runTask(pool, 'fail', undefined)).rejects.toMatchObject({
      code: 'decode',
      message: 'boom',
    });
    const controller = new AbortController();
    const discard = vi.fn();
    const job = runTask(pool, 'slow', 7, {
      signal: controller.signal,
      discard,
    });
    controller.abort();
    await expect(job).rejects.toMatchObject({ code: 'aborted' });
    expect(discard).toHaveBeenCalledWith(7);
  });

  it('keeps views alone over their buffer, and lists each buffer once', () => {
    const whole = new Float32Array(4);
    expect(owned(whole)).toBe(whole);
    const part = new Float32Array(new ArrayBuffer(32), 8, 2);
    const copy = owned(part);
    expect(copy).not.toBe(part);
    expect(copy).toBeInstanceOf(Float32Array);
    expect(copy.buffer.byteLength).toBe(8);
    expect(buffersOf([whole, whole.subarray(1), undefined, copy])).toEqual([
      whole.buffer,
      copy.buffer,
    ]);
  });
});
