import {
  defineResourceType,
  MemorySource,
  ResourceStore,
  type ResourceBytes,
} from '@fdw/engine-resources';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createImageBitmapDecoder } from './BitmapImageDecoder';
import { FileSource } from './FileSource';
import {
  sniffImageFormat,
  type DecodedImage,
  type ImageDecoder,
} from './ImageDecoder';
import {
  hotChannel,
  withChangeChannel,
  withPolling,
  type HotContext,
} from './watch';
import {
  createWorkerImageDecoder,
  serveImageDecoder,
} from './WorkerImageDecoder';
import {
  serveWorker,
  WorkerPool,
  type PoolWorker,
  type WorkerScope,
} from './WorkerPool';

const sleep = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const signal = () => new AbortController().signal;
const bytesOf = (...n: number[]) => new Uint8Array(n) as ResourceBytes;
const fakeBitmap = (w = 2, h = 3) =>
  ({ width: w, height: h, close: vi.fn() }) as unknown as ImageBitmap;

// Type-level: a real Worker can be pooled.
const _pooled: PoolWorker = null as unknown as Worker;
void _pooled;

describe('sniffImageFormat', () => {
  it('recognizes formats by their magic bytes', () => {
    expect(sniffImageFormat(bytesOf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a))).toBe(
      'png',
    );
    expect(sniffImageFormat(bytesOf(0xff, 0xd8, 0xff, 0xe0))).toBe('jpeg');
    expect(sniffImageFormat(new TextEncoder().encode('GIF89a'))).toBe('gif');
    expect(
      sniffImageFormat(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')),
    ).toBe('webp');
    expect(
      sniffImageFormat(new TextEncoder().encode('\0\0\0\x1cftypavif')),
    ).toBe('avif');
    expect(
      sniffImageFormat(bytesOf(0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb)),
    ).toBe('ktx2');
    expect(
      sniffImageFormat(new TextEncoder().encode('hello world')),
    ).toBeUndefined();
    expect(sniffImageFormat(new Uint8Array())).toBeUndefined();
  });
});

describe('createImageBitmapDecoder', () => {
  it('asks for raw pixels: no color conversion, no premultiplied alpha', async () => {
    const bitmap = fakeBitmap(4, 5);
    const create = vi.fn(async () => bitmap);
    const image = await createImageBitmapDecoder({
      createImageBitmap: create,
    }).decode(bytesOf(1, 2, 3), {
      mimeType: 'image/png',
    });
    expect(image).toEqual({ width: 4, height: 5, bitmap });
    const [blob, options] = create.mock.calls[0] as unknown as [
      Blob,
      ImageBitmapOptions,
    ];
    expect(blob.size).toBe(3);
    expect(blob.type).toBe('image/png');
    expect(options).toEqual({
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    });
  });

  it('wraps decoding failures', async () => {
    const decoder = createImageBitmapDecoder({
      createImageBitmap: async () => {
        throw new DOMException('bad', 'InvalidStateError');
      },
    });
    await expect(decoder.decode(bytesOf(0))).rejects.toMatchObject({
      code: 'decode',
    });
  });

  it('closes the bitmap when aborted meanwhile', async () => {
    const ctl = new AbortController();
    const bitmap = fakeBitmap();
    const decoder = createImageBitmapDecoder({
      createImageBitmap: async () => (ctl.abort(), bitmap),
    });
    await expect(
      decoder.decode(bytesOf(0), { signal: ctl.signal }),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(bitmap.close).toHaveBeenCalled();
  });

  it('reports a missing createImageBitmap as unsupported', async () => {
    const original = globalThis.createImageBitmap;
    // @ts-expect-error jsdom has none, make it explicit
    globalThis.createImageBitmap = undefined;
    try {
      await expect(
        createImageBitmapDecoder().decode(bytesOf(0)),
      ).rejects.toMatchObject({ code: 'unsupported' });
    } finally {
      globalThis.createImageBitmap = original;
    }
  });
});

// --- Workers -----------------------------------------------------------------

type FakeWorkerHandle = PoolWorker & {
  terminated: boolean;
  transfers: Transferable[][];
  emit(type: string, event: unknown): void;
};

/** An in-process worker: runs `serveWorker` against a fake scope, asynchronously. */
function fakeWorkerFactory(
  setup: (scope: WorkerScope) => void,
  log: { workers: FakeWorkerHandle[] } = { workers: [] },
) {
  class FakeWorker implements PoolWorker {
    terminated = false;
    transfers: Transferable[][] = [];
    private listeners: Record<string, Array<(e: any) => void>> = {};
    private scopeListeners: Array<(e: MessageEvent) => void> = [];
    constructor() {
      const scope: WorkerScope = {
        addEventListener: (_type, l) => void this.scopeListeners.push(l),
        postMessage: (message) =>
          void setTimeout(() => this.emit('message', { data: message }), 0),
      };
      setup(scope);
    }
    postMessage(message: unknown, transfer?: Transferable[]) {
      this.transfers.push(transfer ?? []);
      setTimeout(
        () =>
          this.scopeListeners.forEach((l) =>
            l({ data: message } as MessageEvent),
          ),
        0,
      );
    }
    terminate() {
      this.terminated = true;
    }
    addEventListener(type: string, listener: (e: any) => void) {
      (this.listeners[type] ??= []).push(listener);
    }
    emit(type: string, event: unknown) {
      (this.listeners[type] ?? []).forEach((l) => l(event));
    }
  }
  return {
    create: () => {
      const w = new FakeWorker();
      log.workers.push(w);
      return w;
    },
    log,
  };
}

describe('WorkerPool', () => {
  const echo = (scope: WorkerScope) =>
    serveWorker<{ n: number; fail?: boolean; delay?: number }, number>(
      async ({ n, fail, delay }) => {
        if (delay) await sleep(delay);
        if (fail) throw new RangeError('boom');
        return { result: n * 2 };
      },
      scope,
    );

  it('runs jobs and starts workers only when needed', async () => {
    const { create, log } = fakeWorkerFactory(echo);
    const pool = new WorkerPool({ create, size: 3 });
    expect(await pool.run({ n: 2 })).toBe(4);
    expect(await pool.run({ n: 3 })).toBe(6);
    expect(log.workers).toHaveLength(1); // sequential jobs reuse the idle worker
    const both = await Promise.all([
      pool.run({ n: 1, delay: 5 }),
      pool.run({ n: 2, delay: 5 }),
      pool.run({ n: 3, delay: 5 }),
    ]);
    expect(both).toEqual([2, 4, 6]);
    expect(log.workers).toHaveLength(3);
  });

  it('rejects with the error of the worker', async () => {
    const pool = new WorkerPool({ ...fakeWorkerFactory(echo), size: 1 });
    await expect(pool.run({ n: 1, fail: true })).rejects.toMatchObject({
      code: 'decode',
      message: 'boom',
    });
    expect(await pool.run({ n: 5 })).toBe(10); // still usable
  });

  it('drops the result of an aborted job, and discards it', async () => {
    const pool = new WorkerPool({ ...fakeWorkerFactory(echo), size: 1 });
    const ctl = new AbortController();
    const discard = vi.fn();
    const p = pool.run({ n: 7, delay: 5 }, { signal: ctl.signal, discard });
    ctl.abort();
    await expect(p).rejects.toMatchObject({ code: 'aborted' });
    await sleep(20);
    expect(discard).toHaveBeenCalledWith(14);
    await expect(
      pool.run({ n: 1 }, { signal: ctl.signal }),
    ).rejects.toMatchObject({ code: 'aborted' });
  });

  it('replaces a crashed worker and fails its jobs', async () => {
    const { create, log } = fakeWorkerFactory(echo);
    const pool = new WorkerPool({ create, size: 1 });
    const p = pool.run({ n: 1, delay: 20 });
    log.workers[0].emit('error', { message: 'out of memory' });
    await expect(p).rejects.toMatchObject({ code: 'io' });
    expect(log.workers[0].terminated).toBe(true);
    expect(await pool.run({ n: 4 })).toBe(8);
    expect(log.workers).toHaveLength(2);
  });

  it('rejects everything once terminated', async () => {
    const { create, log } = fakeWorkerFactory(echo);
    const pool = new WorkerPool({ create, size: 1 });
    const p = pool.run({ n: 1, delay: 20 });
    pool.terminate();
    await expect(p).rejects.toMatchObject({ code: 'aborted' });
    expect(log.workers[0].terminated).toBe(true);
    await expect(pool.run({ n: 1 })).rejects.toMatchObject({ code: 'aborted' });
  });
});

describe('createWorkerImageDecoder', () => {
  const inWorker: ImageDecoder = {
    decode: vi.fn(async (bytes: ResourceBytes): Promise<DecodedImage> => ({
      width: bytes.byteLength,
      height: 1,
      bitmap: fakeBitmap(),
    })),
  };
  const factory = () =>
    fakeWorkerFactory((scope) => serveImageDecoder(scope, inWorker));

  it('decodes in the worker and transfers the buffer', async () => {
    const f = factory();
    const decoder = createWorkerImageDecoder(new WorkerPool({ ...f, size: 1 }));
    const bytes = bytesOf(1, 2, 3, 4);
    const image = await decoder.decode(bytes, { mimeType: 'image/png' });
    expect(image.width).toBe(4);
    expect(f.log.workers[0].transfers[0]).toEqual([bytes.buffer]);
  });

  it('can copy instead of transferring', async () => {
    const f = factory();
    const decoder = createWorkerImageDecoder(
      new WorkerPool({ ...f, size: 1 }),
      { transferBytes: false },
    );
    await decoder.decode(bytesOf(1, 2));
    expect(f.log.workers[0].transfers[0]).toEqual([]);
  });

  it('closes a bitmap that arrives after the abort', async () => {
    const bitmap = fakeBitmap();
    const slow: ImageDecoder = {
      decode: async (bytes) => (
        await sleep(5),
        { width: bytes.byteLength, height: 1, bitmap }
      ),
    };
    const f = fakeWorkerFactory((scope) => serveImageDecoder(scope, slow));
    const decoder = createWorkerImageDecoder(new WorkerPool({ ...f, size: 1 }));
    const ctl = new AbortController();
    const p = decoder.decode(bytesOf(1), { signal: ctl.signal });
    ctl.abort();
    await expect(p).rejects.toMatchObject({ code: 'aborted' });
    await sleep(20);
    expect(bitmap.close).toHaveBeenCalled();
  });
});

// --- Files -------------------------------------------------------------------

describe('FileSource', () => {
  const file = (name: string, content: string) =>
    new File([content], name, { lastModified: 1000 });
  const read = async (s: FileSource, p: string) =>
    new TextDecoder().decode(await s.read(p, { signal: signal() }));

  it('reads, lists and stats the files it was given', async () => {
    const s = new FileSource()
      .add(file('a.txt', 'hello'))
      .add(file('b.txt', 'x'), 'dir/b.txt');
    expect(await read(s, 'a.txt')).toBe('hello');
    expect(await read(s, './dir/b.txt')).toBe('x');
    expect(await s.list('dir/')).toEqual(['dir/b.txt']);
    expect(await s.stat('a.txt')).toEqual({ size: 5, revision: '1000' });
    await expect(s.read('nope', { signal: signal() })).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('notifies the watchers when a path is replaced or removed', () => {
    const s = new FileSource().add(file('a.txt', '1'));
    const cb = vi.fn();
    const stop = s.watch('a.txt', cb);
    s.add(file('a.txt', '2'));
    expect(cb).toHaveBeenCalledTimes(1);
    s.remove('a.txt');
    expect(cb).toHaveBeenCalledTimes(2);
    stop();
    s.add(file('a.txt', '3'));
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('walks the folders of a drop, in batches', async () => {
    const fileEntry = (path: string, content: string) => ({
      isFile: true,
      isDirectory: false,
      fullPath: path,
      file: (ok: (f: File) => void) =>
        ok(file(path.split('/').pop()!, content)),
    });
    const dirEntry = (path: string, children: unknown[]) => {
      const batches = [children.slice(0, 1), children.slice(1), []];
      return {
        isFile: false,
        isDirectory: true,
        fullPath: path,
        createReader: () => ({
          readEntries: (ok: (e: unknown[]) => void) => ok(batches.shift()!),
        }),
      };
    };
    const tree = dirEntry('/model', [
      fileEntry('/model/m.obj', 'obj'),
      fileEntry('/model/m.mtl', 'mtl'),
      dirEntry('/model/tex', [fileEntry('/model/tex/a.png', 'png')]),
    ]);
    const data = {
      items: [
        { kind: 'file', webkitGetAsEntry: () => tree },
        { kind: 'string', webkitGetAsEntry: () => null },
      ],
    } as unknown as DataTransfer;
    const s = new FileSource();
    const added = await s.addFromDataTransfer(data);
    expect(added.sort()).toEqual([
      'model/m.mtl',
      'model/m.obj',
      'model/tex/a.png',
    ]);
    expect(await read(s, 'model/tex/a.png')).toBe('png');
  });
});

// --- Watching ------------------------------------------------------------------

describe('watching', () => {
  afterEach(() => vi.useRealTimers());

  it('maps a channel of changed paths onto source.watch', () => {
    let emit!: (path: string) => void;
    const source = withChangeChannel(new MemorySource({ 'a/b.png': 'x' }), {
      subscribe: (l) => ((emit = l), () => undefined),
    });
    const cb = vi.fn();
    source.watch!('a/b.png', cb);
    emit('/a/b.png'); // the dev server speaks in absolute paths
    emit('other.png');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('builds a channel from a Vite hot context', () => {
    const handlers = new Map<string, (d: unknown) => void>();
    const hot: HotContext = {
      on: (e, cb) => void handlers.set(e, cb),
      off: (e) => void handlers.delete(e),
    };
    const listener = vi.fn();
    const stop = hotChannel(hot).subscribe(listener);
    handlers.get('fdw:resource-changed')!('tex/a.png');
    handlers.get('fdw:resource-changed')!({ path: 'tex/b.png' });
    handlers.get('fdw:resource-changed')!({ nonsense: true });
    expect(listener.mock.calls).toEqual([['tex/a.png'], ['tex/b.png']]);
    stop();
    expect(handlers.size).toBe(0);
  });

  it('polls the revision of a path and notifies on change only', async () => {
    vi.useFakeTimers();
    const mem = new MemorySource({ f: '1' });
    const source = withPolling(mem, { intervalMs: 100 });
    const cb = vi.fn();
    const stop = source.watch!('f', cb);
    await vi.advanceTimersByTimeAsync(250);
    expect(cb).not.toHaveBeenCalled(); // the first check is a baseline
    mem.set('f', '2');
    cb.mockClear(); // MemorySource itself notifies its own watchers, not the poller
    await vi.advanceTimersByTimeAsync(150);
    expect(cb).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(cb).toHaveBeenCalledTimes(1);
    stop();
    mem.set('f', '3');
    await vi.advanceTimersByTimeAsync(500);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('refuses to poll a source that cannot stat', () => {
    expect(() =>
      withPolling({ read: async () => new Uint8Array() as ResourceBytes }),
    ).toThrow(/stat/);
  });
});

// --- Integration: store + web pieces --------------------------------------------

describe('with a ResourceStore', () => {
  const ImageType = defineResourceType<DecodedImage>('decoded-image');

  it('hot-reloads an image dropped again over the same path', async () => {
    const store = new ResourceStore({ debounceMs: 0, warn: () => undefined });
    const files = new FileSource();
    store.mount('files', files, { default: true });

    const bitmaps: ImageBitmap[] = [];
    const decoder = createImageBitmapDecoder({
      createImageBitmap: async (blob) => {
        const b = fakeBitmap((blob as Blob).size, 1);
        bitmaps.push(b);
        return b;
      },
    });
    store.registerLoader({
      type: ImageType,
      extensions: ['png'],
      sniff: (head) => sniffImageFormat(head) === 'png',
      load: async (ctx) =>
        decoder.decode(await ctx.bytes(), { signal: ctx.signal }),
      dispose: (image) => image.bitmap.close(),
    });

    files.add(new File(['12345'], 'tex.png'));
    store.watch(true);
    const handle = store.load(ImageType, 'tex.png');
    expect((await handle.ready).width).toBe(5);

    files.add(new File(['1234567'], 'tex.png')); // dropped again
    await sleep(15);
    store.update();
    expect(handle.value?.width).toBe(7);
    expect(handle.version.value).toBe(2);
    expect(bitmaps[0].close).toHaveBeenCalled(); // the old bitmap is freed
    expect(bitmaps[1].close).not.toHaveBeenCalled();
  });
});
