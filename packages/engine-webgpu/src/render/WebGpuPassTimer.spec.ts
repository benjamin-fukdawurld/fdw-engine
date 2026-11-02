import type { GpuCommandEncoder } from '@fdw/engine-backend';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebGpuPassTimer } from './WebGpuPassTimer';

// GPUBufferUsage and GPUMapMode only exist in a WebGPU context.
beforeAll(() => {
  Object.assign(globalThis, {
    GPUBufferUsage: {
      MAP_READ: 1,
      COPY_SRC: 4,
      COPY_DST: 8,
      QUERY_RESOLVE: 512,
    },
    GPUMapMode: { READ: 1 },
  });
  // 10 ms between the reads of the clock.
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => (now += 10));
});

afterAll(() => vi.restoreAllMocks());

// A fake device whose query set keeps its timestamps from frame to frame,
// as a GPU does: the passes write theirs when run.
function fakeDevice() {
  const stamps = new BigInt64Array(8);
  const memory = new Map<object, BigInt64Array>();
  const device = {
    createQuerySet: () => ({ destroy: () => undefined }),
    createBuffer: ({ size }: GPUBufferDescriptor) => {
      const buffer = {
        mapAsync: async () => undefined,
        getMappedRange: () => memory.get(buffer)!.slice().buffer,
        unmap: () => undefined,
        destroy: () => undefined,
      };
      memory.set(buffer, new BigInt64Array(size / 8));
      return buffer;
    },
  };
  // An encoder resolving the timestamps written so far.
  const encoder = () => ({
    timers: new Set<WebGpuPassTimer>(),
    gpu: {
      resolveQuerySet: (
        _: GPUQuerySet,
        first: number,
        count: number,
        destination: object,
      ) => memory.get(destination)!.set(stamps.subarray(first, first + count)),
      copyBufferToBuffer: (
        source: object,
        _: number,
        destination: object,
        __: number,
        size: number,
      ) =>
        memory.get(destination)!.set(memory.get(source)!.subarray(0, size / 8)),
    },
  });
  return { device: device as unknown as GPUDevice, stamps, encoder };
}

describe('WebGpuPassTimer', () => {
  it('measures only the passes run in the frame', async () => {
    const { device, stamps, encoder } = fakeDevice();
    const timer = new WebGpuPassTimer(device, 4);
    const frame = async (
      index: number,
      passes: readonly [number, bigint, bigint][],
    ) => {
      for (const [slot, begin, end] of passes) {
        timer.timestampWrites(slot);
        stamps[slot * 2] = begin;
        stamps[slot * 2 + 1] = end;
      }
      timer.resolve(encoder() as unknown as GpuCommandEncoder, index);
      timer.submitted();
      await new Promise((resolve) => setTimeout(resolve));
      return [...(timer.read()?.durations ?? [])];
    };

    expect(
      await frame(1, [
        [0, 1_000_000n, 3_000_000n],
        [1, 3_000_000n, 4_000_000n],
      ]),
    ).toEqual([2, 1, NaN, NaN]);
    // Pass 0 not run: the timestamps of frame 1 it keeps are not read.
    expect(await frame(2, [[1, 90_000_000_000n, 90_001_000_000n]])).toEqual([
      NaN,
      1,
      NaN,
      NaN,
    ]);
    // Longer than the frame: garbage.
    expect(await frame(3, [[0, 1_000_000n, 90_000_000_000n]])).toEqual([
      NaN,
      NaN,
      NaN,
      NaN,
    ]);
    // Nothing run: nothing measured.
    expect(await frame(4, [])).toEqual([NaN, NaN, NaN, NaN]);
    expect(timer.read()?.frame).toBe(3);
  });
});
