import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defineResourceType,
  ResourceError,
  ResourceStore,
  type DecodePool,
} from '@fdw/engine-resources';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileSource } from './FileSource';
import { createStbImageDecoder, sniffStbImage } from './ImageDecoder';
import { withFileWatch } from './watch';
import { WorkerPool } from './WorkerPool';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const signal = new AbortController().signal;
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

// Type-level: the pool serves the decoders (glTF, KTX2) as a `DecodePool`.
const _decodePool: DecodePool = null as unknown as WorkerPool;
void _decodePool;

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fdw-resources-'));
  await mkdir(join(root, 'models', 'oak'), { recursive: true });
  await writeFile(join(root, 'models', 'oak', 'oak.obj'), 'v 0 0 0');
  await writeFile(join(root, 'readme.txt'), 'hello');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('FileSource', () => {
  it('reads files under its root, with either slash', async () => {
    const files = new FileSource(root);
    const progress: number[] = [];
    const bytes = await files.read('models\\oak/./oak.obj', {
      signal,
      onProgress: (l) => progress.push(l),
    });
    expect(text(bytes)).toBe('v 0 0 0');
    expect(bytes.buffer.byteLength).toBe(bytes.byteLength); // its own buffer
    expect(progress).toEqual([7]);
  });

  it('reports missing files and refuses paths out of its root', async () => {
    const files = new FileSource(join(root, 'models'));
    await expect(files.read('nope.obj', { signal })).rejects.toMatchObject({
      code: 'not-found',
    });
    await expect(files.read('../readme.txt', { signal })).rejects.toMatchObject(
      { code: 'not-found' },
    );
    await expect(files.read('oak', { signal })).rejects.toBeInstanceOf(
      ResourceError,
    ); // a directory
  });

  it('stats and lists', async () => {
    const files = new FileSource(root);
    const stat = await files.stat('readme.txt');
    expect(stat.size).toBe(5);
    expect(stat.revision).toBeTypeOf('string');
    expect(await files.list('')).toEqual(['models/oak/oak.obj', 'readme.txt']);
    expect(await files.list('models')).toEqual(['models/oak/oak.obj']);
    expect(await files.list('missing')).toEqual([]);
  });

  it('serves a ResourceStore and hot-reloads on change', async () => {
    const TextType = defineResourceType<string>('text');
    const store = new ResourceStore({ debounceMs: 20, warn: () => undefined });
    store.mount('assets', withFileWatch(new FileSource(root)), {
      default: true,
    });
    store.registerLoader({ type: TextType, load: (ctx) => ctx.text() });
    store.watch(true);
    const handle = store.load(TextType, 'readme.txt');
    expect(await handle.ready).toBe('hello');
    await sleep(50);
    await writeFile(join(root, 'readme.txt'), 'changed');
    await expect
      .poll(() => (store.update(), handle.value), { timeout: 3000 })
      .toBe('changed');
    store.dispose();
  });
});

describe('WorkerPool', () => {
  const url = new URL('./testing/echo.worker.mjs', import.meta.url);

  it('runs jobs in workers, transferring the bytes', async () => {
    const pool = new WorkerPool({ url, size: 2 });
    const bytes = new Uint8Array(16);
    const results = await Promise.all([
      pool.run<{ length: number }>({ bytes }, { transfer: [bytes.buffer] }),
      pool.run<{ echo: string }>({ echo: 'b' }),
    ]);
    expect(results[0].length).toBe(16);
    expect(bytes.byteLength).toBe(0); // moved
    expect(results[1].echo).toBe('b');
    await pool.terminate();
  });

  it('reports errors, cancels and survives a crash', async () => {
    const pool = new WorkerPool({ url, size: 1 });
    await expect(pool.run({ fail: 'bad image' })).rejects.toMatchObject({
      code: 'decode',
      message: 'bad image',
    });
    const controller = new AbortController();
    const slow = pool.run(
      { delay: 50, echo: 'late' },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(slow).rejects.toMatchObject({ code: 'aborted' });
    await expect(pool.run({ crash: true })).rejects.toMatchObject({
      code: 'io',
    });
    expect(await pool.run<{ echo: string }>({ echo: 'again' })).toEqual({
      length: 0,
      echo: 'again',
    });
    await pool.terminate();
    await expect(pool.run({})).rejects.toMatchObject({ code: 'aborted' });
  });
});

describe('stb image decoder', () => {
  it('wraps the addon and its errors', async () => {
    const pixels = new Uint8Array([1, 2, 3, 4]);
    const decoder = createStbImageDecoder({
      addon: {
        decodeImage: async (bytes) => {
          if (bytes.length === 0) throw new Error('unknown image type');
          return { width: 1, height: 1, channels: 3, hdr: false, pixels };
        },
      },
    });
    expect(await decoder.decode(new Uint8Array(1))).toEqual({
      width: 1,
      height: 1,
      pixels,
      hdr: false,
    });
    await expect(decoder.decode(new Uint8Array(0))).rejects.toMatchObject({
      code: 'decode',
    });
    const aborted = AbortSignal.abort();
    await expect(
      decoder.decode(new Uint8Array(1), { signal: aborted }),
    ).rejects.toMatchObject({ code: 'aborted' });
  });

  it('recognizes its formats', () => {
    expect(sniffStbImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
    expect(sniffStbImage(new TextEncoder().encode('#?RADIANCE\n'))).toBe(true);
    expect(sniffStbImage(new TextEncoder().encode('RIFF....WEBP'))).toBe(false);
  });

  const addon = new URL(
    '../../engine-native/build/fdw_native.node',
    import.meta.url,
  ).pathname;
  it.skipIf(!existsSync(addon))(
    'decodes a PNG with the real addon',
    async () => {
      const png = await readFile(
        new URL(
          '../../../apps/demo/public/sphere-diffuse.png',
          import.meta.url,
        ),
      );
      const image = await createStbImageDecoder().decode(new Uint8Array(png));
      expect([image.width, image.height, image.hdr]).toEqual([416, 585, false]);
      expect(image.pixels).toBeInstanceOf(Uint8Array);
      expect(image.pixels.length).toBe(416 * 585 * 4);
    },
  );
});
