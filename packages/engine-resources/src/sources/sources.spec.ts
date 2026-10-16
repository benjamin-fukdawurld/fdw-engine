import { deflateRawSync, crc32 } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { ResourceError } from '../errors';
import { ArchiveSource } from './ArchiveSource';
import { DataUriSource } from './DataUriSource';
import { HttpSource } from './HttpSource';
import { MemorySource } from './MemorySource';

const signal = () => new AbortController().signal;
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe('MemorySource', () => {
  it('reads, stats and lists', async () => {
    const m = new MemorySource({ 'a/b.txt': 'hello', 'a/c.txt': 'x' });
    expect(text(await m.read('a/b.txt', { signal: signal() }))).toBe('hello');
    expect((await m.stat('a/b.txt')).size).toBe(5);
    expect(await m.list('a/')).toEqual(['a/b.txt', 'a/c.txt']);
  });

  it('rejects a missing path with not-found', async () => {
    await expect(
      new MemorySource().read('nope', { signal: signal() }),
    ).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('changes the revision and notifies watchers on set', async () => {
    const m = new MemorySource({ f: '1' });
    const before = (await m.stat('f')).revision;
    const cb = vi.fn();
    const stop = m.watch('f', cb);
    m.set('f', '2');
    expect(cb).toHaveBeenCalledTimes(1);
    expect((await m.stat('f')).revision).not.toBe(before);
    stop();
    m.set('f', '3');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('hands out copies', async () => {
    const m = new MemorySource({ f: 'abc' });
    const a = await m.read('f', { signal: signal() });
    a[0] = 0;
    expect(text(await m.read('f', { signal: signal() }))).toBe('abc');
  });
});

describe('DataUriSource', () => {
  it('decodes base64 and plain payloads', async () => {
    const s = new DataUriSource();
    expect(
      text(await s.read('text/plain;base64,aGVsbG8=', { signal: signal() })),
    ).toBe('hello');
    expect(
      text(await s.read('text/plain,hi%20there', { signal: signal() })),
    ).toBe('hi there');
  });
});

describe('HttpSource', () => {
  const body = (
    chunks: string[],
    headers: Record<string, string> = {},
    status = 200,
  ) => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        c.close();
      },
    });
    return new Response(stream, { status, headers });
  };

  it('joins the base, reads the stream and reports progress', async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) =>
      body(['ab', 'cde'], { 'content-length': '5' }),
    );
    const src = new HttpSource({
      base: '/assets',
      fetch: fetchFn as unknown as typeof fetch,
    });
    const progress: Array<[number, number | undefined]> = [];
    const bytes = await src.read('m/a.bin', {
      signal: signal(),
      onProgress: (l, t) => progress.push([l, t]),
    });
    expect(text(bytes)).toBe('abcde');
    expect(fetchFn.mock.calls[0][0]).toBe('/assets/m/a.bin');
    expect(progress[0]).toEqual([2, 5]);
    expect(progress.at(-1)).toEqual([5, 5]);
  });

  it('uses absolute URLs as they are', async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) =>
      body(['x']),
    );
    const src = new HttpSource({
      base: '/a/',
      fetch: fetchFn as unknown as typeof fetch,
    });
    await src.read('https://cdn.example.com/x.png', { signal: signal() });
    expect(fetchFn.mock.calls[0][0]).toBe('https://cdn.example.com/x.png');
  });

  it('maps statuses to error codes', async () => {
    const mk = (status: number) =>
      new HttpSource({
        fetch: (async () => body([], {}, status)) as unknown as typeof fetch,
      });
    await expect(mk(404).read('x', { signal: signal() })).rejects.toMatchObject(
      { code: 'not-found' },
    );
    await expect(mk(500).read('x', { signal: signal() })).rejects.toMatchObject(
      { code: 'io' },
    );
  });

  it('maps an aborted fetch to aborted', async () => {
    const ctl = new AbortController();
    const fetchFn = ((_url: string, init: RequestInit) =>
      new Promise((_res, rej) => {
        init.signal!.addEventListener('abort', () =>
          rej(new DOMException('x', 'AbortError')),
        );
      })) as unknown as typeof fetch;
    const p = new HttpSource({ fetch: fetchFn }).read('x', {
      signal: ctl.signal,
    });
    ctl.abort();
    await expect(p).rejects.toMatchObject({ code: 'aborted' });
  });

  it('stats with the ETag', async () => {
    const fetchFn = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(null, {
          headers: { etag: '"v1"', 'content-length': '9' },
        }),
    );
    const stat = await new HttpSource({
      fetch: fetchFn as unknown as typeof fetch,
    }).stat('x');
    expect(stat).toEqual({ size: 9, revision: '"v1"' });
    expect(fetchFn.mock.calls[0][1]).toMatchObject({ method: 'HEAD' });
  });
});

// --- a minimal zip writer, to test the reader -----------------------------

function zip(
  files: Record<string, { data: string; deflate?: boolean }>,
): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, { data, deflate }] of Object.entries(files)) {
    const raw = enc.encode(data);
    const stored = deflate ? deflateRawSync(raw) : raw;
    const nameBytes = enc.encode(name);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, deflate ? 8 : 0, true);
    lv.setUint32(14, crc32(raw), true);
    lv.setUint32(18, stored.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, deflate ? 8 : 0, true);
    cv.setUint32(16, crc32(raw), true);
    cv.setUint32(20, stored.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    parts.push(local, stored);
    central.push(cd);
    offset += local.length + stored.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const all = [...parts, ...central, eocd];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of all) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe('ArchiveSource (zip)', () => {
  const archive = zip({
    'trees/oak.txt': { data: 'oak oak oak oak oak oak', deflate: true },
    'trees/pine.txt': { data: 'pine' },
    'dir/': { data: '' },
  });

  it('reads stored and deflated entries', async () => {
    const mem = new MemorySource({ 'pack.zip': archive });
    const src = new ArchiveSource({ source: mem, path: 'pack.zip' });
    expect(text(await src.read('trees/oak.txt', { signal: signal() }))).toBe(
      'oak oak oak oak oak oak',
    );
    expect(text(await src.read('trees/pine.txt', { signal: signal() }))).toBe(
      'pine',
    );
    expect(await src.list('trees/')).toEqual([
      'trees/oak.txt',
      'trees/pine.txt',
    ]);
    expect((await src.stat('trees/pine.txt')).size).toBe(4);
  });

  it('reads the archive once', async () => {
    const mem = new MemorySource({ 'pack.zip': archive });
    const read = vi.spyOn(mem, 'read');
    const src = new ArchiveSource({ source: mem, path: 'pack.zip' });
    await Promise.all([
      src.read('trees/oak.txt', { signal: signal() }),
      src.read('trees/pine.txt', { signal: signal() }),
    ]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('reports a missing entry as not-found and honors the prefix', async () => {
    const mem = new MemorySource({ 'pack.zip': archive });
    const src = new ArchiveSource({
      source: mem,
      path: 'pack.zip',
      prefix: 'trees',
    });
    expect(text(await src.read('pine.txt', { signal: signal() }))).toBe('pine');
    await expect(src.read('nope', { signal: signal() })).rejects.toBeInstanceOf(
      ResourceError,
    );
  });

  it('rejects data that is not a zip', async () => {
    const mem = new MemorySource({
      'bad.zip': 'not a zip at all, really not a zip',
    });
    const src = new ArchiveSource({ source: mem, path: 'bad.zip' });
    await expect(src.read('x', { signal: signal() })).rejects.toMatchObject({
      code: 'decode',
    });
  });

  it('drops the index when the archive changes', async () => {
    const mem = new MemorySource({ 'pack.zip': archive });
    const src = new ArchiveSource({ source: mem, path: 'pack.zip' });
    const cb = vi.fn();
    src.watch('trees/pine.txt', cb);
    await src.read('trees/pine.txt', { signal: signal() });
    mem.set('pack.zip', zip({ 'trees/pine.txt': { data: 'PINE' } }));
    expect(cb).toHaveBeenCalled();
    expect(text(await src.read('trees/pine.txt', { signal: signal() }))).toBe(
      'PINE',
    );
  });
});
