import {
  ImageAssetType,
  installAssets,
  TextureType,
  type ImageAsset,
  type Texture,
} from '@fdw/engine-assets';
import type { GpuTextureFormat } from '@fdw/engine-backend';
import { fakeBackend } from '@fdw/engine-core/testing';
import {
  createLocalPool,
  MemorySource,
  ResourceError,
  ResourceStore,
  type DecodePool,
  type TaskMessage,
} from '@fdw/engine-resources';
import { describe, expect, it } from 'vitest';
import {
  basisTarget,
  ensureSupported,
  installKtx2,
  ktx2Codec,
  supportsImage,
  type BasisTarget,
  type BasisTranscoder,
  type Ktx2Options,
} from './codec';
import { isKtx2, KTX2_IDENTIFIER, parseKtx2 } from './container';
import { ktx2WorkerTasks, type Ktx2WorkerOptions } from './workers';

interface Ktx2File {
  readonly vkFormat: number;
  readonly width: number;
  readonly height: number;
  readonly depth?: number;
  readonly layers?: number;
  readonly faces?: number;
  /** The data of the levels as stored, level 0 first. */
  readonly levels: readonly Uint8Array[];
  /** The sizes of the levels once inflated: those of `levels` by default. */
  readonly uncompressed?: readonly number[];
  readonly scheme?: number;
  readonly colorModel?: number;
  /** The channel identifiers of the samples of the DFD. */
  readonly channels?: readonly number[];
  readonly keyValues?: Record<string, string>;
  readonly globalData?: Uint8Array;
}

const align = (n: number, to = 8) => Math.ceil(n / to) * to;

/** Writes a KTX2 file: header, level index, DFD, key/value data, global data, then the levels, the smallest first. */
function writeKtx2(file: Ktx2File): Uint8Array {
  const { levels, channels = [0] } = file;
  const dfdSize = 4 + 24 + 16 * channels.length;
  const encoder = new TextEncoder();
  const pairs = Object.entries(file.keyValues ?? {}).map(([k, v]) =>
    encoder.encode(`${k}\0${v}\0`),
  );
  const kvdSize = pairs.reduce((sum, p) => sum + 4 + align(p.byteLength, 4), 0);
  const globalData = file.globalData ?? new Uint8Array(0);

  const dfdOffset = 80 + 24 * levels.length;
  const kvdOffset = dfdOffset + dfdSize;
  const sgdOffset = globalData.byteLength ? align(kvdOffset + kvdSize) : 0;
  let end = align(
    sgdOffset ? sgdOffset + globalData.byteLength : kvdOffset + kvdSize,
  );
  const offsets: number[] = [];
  for (let i = levels.length - 1; i >= 0; i--) {
    offsets[i] = end;
    end = align(end + levels[i].byteLength);
  }

  const bytes = new Uint8Array(end);
  const view = new DataView(bytes.buffer);
  bytes.set(KTX2_IDENTIFIER);
  const header = [
    file.vkFormat,
    1,
    file.width,
    file.height,
    file.depth ?? 0,
    file.layers ?? 0,
    file.faces ?? 1,
    levels.length,
    file.scheme ?? 0,
    dfdOffset,
    dfdSize,
    kvdOffset,
    kvdSize,
  ];
  header.forEach((value, i) => view.setUint32(12 + i * 4, value, true));
  view.setBigUint64(64, BigInt(sgdOffset), true);
  view.setBigUint64(72, BigInt(globalData.byteLength), true);
  levels.forEach((data, i) => {
    const at = 80 + i * 24;
    view.setBigUint64(at, BigInt(offsets[i]), true);
    view.setBigUint64(at + 8, BigInt(data.byteLength), true);
    view.setBigUint64(
      at + 16,
      BigInt(file.uncompressed?.[i] ?? data.byteLength),
      true,
    );
    bytes.set(data, offsets[i]);
  });

  view.setUint32(dfdOffset, dfdSize, true);
  view.setUint16(dfdOffset + 4 + 4, 2, true);
  view.setUint16(dfdOffset + 4 + 6, 24 + 16 * channels.length, true);
  bytes.set([file.colorModel ?? 1, 1, 2, 0], dfdOffset + 4 + 8);
  channels.forEach((channel, i) => {
    const at = dfdOffset + 4 + 24 + i * 16;
    view.setUint16(at, i * 8, true);
    view.setUint8(at + 2, 7);
    view.setUint8(at + 3, channel);
  });

  let at = kvdOffset;
  for (const pair of pairs) {
    view.setUint32(at, pair.byteLength, true);
    bytes.set(pair, at + 4);
    at += 4 + align(pair.byteLength, 4);
  }
  bytes.set(globalData, sgdOffset);
  return bytes;
}

/** Bytes counting from a start value. */
const filled = (length: number, start = 0) =>
  Uint8Array.from({ length }, (_, i) => (start + i) & 0xff);

const R8G8B8A8_UNORM = 37;
const R8G8B8A8_SRGB = 43;
const R8_UNORM = 9;
const R16G16B16A16_SFLOAT = 97;
const BC7_UNORM = 145;

// An rgba8 4×4 image with its 3 levels.
const mipLevels = [filled(64, 0), filled(16, 100), filled(4, 200)];
const mipmapped = (vkFormat = R8G8B8A8_UNORM) =>
  writeKtx2({ vkFormat, width: 4, height: 4, levels: mipLevels });

// BC7 8×8, 2 levels: 4 blocks then 1, of 16 bytes.
const bc7File = () =>
  writeKtx2({
    vkFormat: BC7_UNORM,
    width: 8,
    height: 8,
    levels: [filled(64, 1), filled(16, 2)],
  });

const decode = (bytes: Uint8Array, options?: Ktx2Options, uri = 'a.ktx2') =>
  ktx2Codec(options).decode(new Uint8Array(bytes), { uri });

const rejection = async (promise: Promise<unknown>): Promise<ResourceError> => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ResourceError);
  return error as ResourceError;
};

/** Workers of the tests: the tasks run here, cloned as `postMessage` does. Logs the tasks. */
function workerPool(options: Ktx2WorkerOptions = {}) {
  const local = createLocalPool(ktx2WorkerTasks(options));
  const tasks: string[] = [];
  const workers: DecodePool = {
    run(payload, runOptions) {
      tasks.push((payload as TaskMessage).task);
      return local.run(payload, runOptions);
    },
  };
  return { workers, tasks };
}

async function deflate(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([data])
    .stream()
    .pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe('KTX2 container', () => {
  it('reads the header, the level index, the DFD and the key/value data', () => {
    const bytes = writeKtx2({
      vkFormat: R8G8B8A8_UNORM,
      width: 4,
      height: 4,
      levels: mipLevels,
      keyValues: { KTXwriter: 'test', KTXorientation: 'rd' },
      channels: [0, 1, 2, 15],
    });
    expect(isKtx2(bytes)).toBe(true);
    expect(isKtx2(new TextEncoder().encode('KTX 11'))).toBe(false);
    const ktx = parseKtx2(bytes);
    expect(ktx).toMatchObject({
      vkFormat: 37,
      pixelWidth: 4,
      pixelHeight: 4,
      faceCount: 1,
      levelCount: 3,
    });
    // The index has level 0 first; the data is stored the smallest first.
    expect(ktx.levels.map((l) => l.byteLength)).toEqual([64, 16, 4]);
    expect(ktx.levels[0].byteOffset).toBeGreaterThan(ktx.levels[2].byteOffset);
    expect(
      ktx.dataFormat.samples.map((s) => [s.channelId, s.bitLength]),
    ).toEqual([
      [0, 8],
      [1, 8],
      [2, 8],
      [15, 8],
    ]);
    expect(new TextDecoder().decode(ktx.keyValues.get('KTXwriter'))).toBe(
      'test\0',
    );
    expect(ktx.keyValues.has('KTXorientation')).toBe(true);
  });

  it('fails with decode for a file that is not KTX2 or points outside of itself', async () => {
    expect(
      (await rejection(decode(new TextEncoder().encode('not a ktx2 file'))))
        .code,
    ).toBe('decode');
    const truncated = mipmapped().subarray(0, 150);
    expect((await rejection(decode(truncated))).code).toBe('decode');
  });
});

describe('ktx2Codec', () => {
  it('is found by its identifier, then by its extension', () => {
    const codec = ktx2Codec();
    expect(codec).toMatchObject({ name: 'ktx2', extensions: ['ktx2'] });
    expect(codec.sniff?.(mipmapped().subarray(0, 64))).toBe(true);
    expect(codec.sniff?.(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
  });

  it('decodes the levels of an uncompressed image, level 0 first, sRGB read as linear', async () => {
    for (const vkFormat of [R8G8B8A8_UNORM, R8G8B8A8_SRGB]) {
      const image = await decode(mipmapped(vkFormat));
      expect(image).toMatchObject({
        type: '2d',
        width: 4,
        height: 4,
        format: 'rgba8unorm',
      });
      expect(image.layers).toBeUndefined();
      expect(image.transcode).toBeUndefined();
      expect(
        image.levels.map((l) => [
          ...new Uint8Array(l.buffer, l.byteOffset, l.byteLength),
        ]),
      ).toEqual(mipLevels.map((l) => [...l]));
    }
  });

  it('maps the float formats', async () => {
    const image = await decode(
      writeKtx2({
        vkFormat: R16G16B16A16_SFLOAT,
        width: 2,
        height: 1,
        levels: [filled(16)],
      }),
    );
    expect(image).toMatchObject({
      type: '2d',
      width: 2,
      height: 1,
      format: 'rgba16float',
    });
  });

  it('decodes a cube, its 6 faces as layers', async () => {
    const faces = filled(6 * 2 * 2 * 4);
    const image = await decode(
      writeKtx2({
        vkFormat: R8G8B8A8_UNORM,
        width: 2,
        height: 2,
        faces: 6,
        levels: [faces],
      }),
    );
    expect(image).toMatchObject({
      type: 'cube',
      width: 2,
      height: 2,
      layers: 6,
      format: 'rgba8unorm',
    });
    expect([
      ...new Uint8Array(image.levels[0].buffer, image.levels[0].byteOffset, 96),
    ]).toEqual([...faces]);
  });

  it('decodes a 2d array with its levels', async () => {
    const levels = [filled(3 * 4 * 4, 0), filled(3 * 2 * 2, 50), filled(3, 90)];
    const image = await decode(
      writeKtx2({ vkFormat: R8_UNORM, width: 4, height: 4, layers: 3, levels }),
    );
    expect(image).toMatchObject({
      type: '2d-array',
      layers: 3,
      format: 'r8unorm',
    });
    expect(image.levels.map((l) => l.byteLength)).toEqual([48, 12, 3]);
  });

  it('rejects cube arrays and unknown formats with unsupported, levels of the wrong size with decode', async () => {
    const cubeArray = writeKtx2({
      vkFormat: R8_UNORM,
      width: 1,
      height: 1,
      faces: 6,
      layers: 2,
      levels: [filled(12)],
    });
    expect((await rejection(decode(cubeArray))).code).toBe('unsupported');
    const unknown = writeKtx2({
      vkFormat: 1000,
      width: 1,
      height: 1,
      levels: [filled(4)],
    });
    expect((await rejection(decode(unknown))).code).toBe('unsupported');
    const short = writeKtx2({
      vkFormat: R8G8B8A8_UNORM,
      width: 2,
      height: 2,
      levels: [filled(12)],
    });
    const error = await rejection(decode(short));
    expect(error.code).toBe('decode');
    expect(error.message).toContain('level 0');
  });

  it('gives a GPU compressed format as is, sampled only where the backend has it', async () => {
    const image = await decode(bc7File());
    expect(image).toMatchObject({
      type: '2d',
      width: 8,
      height: 8,
      format: 'bc7-rgba-unorm',
    });
    expect(image.levels.map((l) => l.byteLength)).toEqual([64, 16]);
    expect(image.transcode).toBeUndefined();
    expect(
      supportsImage({ compressedFormats: ['bc7-rgba-unorm'] }, image),
    ).toBe(true);
    expect(
      supportsImage({ compressedFormats: ['astc-4x4-unorm'] }, image),
    ).toBe(false);
    expect(supportsImage(undefined, await decode(mipmapped()))).toBe(true);
    expect(() => ensureSupported({}, image, 'a.ktx2')).toThrow(ResourceError);
    try {
      ensureSupported({}, image, 'a.ktx2');
    } catch (e) {
      expect((e as ResourceError).code).toBe('unsupported');
    }
  });

  it('inflates zstd supercompression with the decoder of the application', async () => {
    // The "compression" of the test reverses the bytes and appends a marker.
    const compressed = mipLevels.map((l) =>
      Uint8Array.from([...l].reverse().concat(0xff)),
    );
    const file = writeKtx2({
      vkFormat: R8G8B8A8_UNORM,
      width: 4,
      height: 4,
      scheme: 2,
      levels: compressed,
      uncompressed: mipLevels.map((l) => l.byteLength),
    });
    const calls: [number, number][] = [];
    const zstd = {
      decode: async (bytes: Uint8Array, size: number) => {
        calls.push([bytes.byteLength, size]);
        return bytes.slice(0, -1).reverse();
      },
    };
    const image = await decode(file, { zstd });
    expect(calls).toEqual([
      [65, 64],
      [17, 16],
      [5, 4],
    ]);
    expect(image.levels.map((l) => [...(l as Uint8Array)])).toEqual(
      mipLevels.map((l) => [...l]),
    );

    const error = await rejection(decode(file));
    expect(error.code).toBe('unsupported');
    expect(error.message).toContain('zstd');
  });

  it('inflates zlib supercompression', async () => {
    const levels = await Promise.all(mipLevels.map((l) => deflate(l)));
    const file = writeKtx2({
      vkFormat: R8G8B8A8_UNORM,
      width: 4,
      height: 4,
      scheme: 3,
      levels,
      uncompressed: mipLevels.map((l) => l.byteLength),
    });
    const image = await decode(file);
    expect(image.levels.map((l) => [...(l as Uint8Array)])).toEqual(
      mipLevels.map((l) => [...l]),
    );
  });
});

describe('KTX2 in workers', () => {
  it('inflates zstd and zlib levels in the workers, the file left whole', async () => {
    const zstdFile = writeKtx2({
      vkFormat: R8G8B8A8_UNORM,
      width: 4,
      height: 4,
      scheme: 2,
      levels: mipLevels.map((l) =>
        Uint8Array.from([...l].reverse().concat(0xff)),
      ),
      uncompressed: mipLevels.map((l) => l.byteLength),
    });
    const sizes: number[] = [];
    const { workers, tasks } = workerPool({
      zstd: {
        decode: (bytes, size) => (
          sizes.push(size),
          bytes.slice(0, -1).reverse()
        ),
      },
    });
    // No decoder here: the workers have it.
    const bytes = new Uint8Array(zstdFile);
    const image = await ktx2Codec({ workers }).decode(bytes, { uri: 'z.ktx2' });
    expect(image.levels.map((l) => [...(l as Uint8Array)])).toEqual(
      mipLevels.map((l) => [...l]),
    );
    expect(sizes).toEqual([64, 16, 4]);
    expect(bytes.byteLength).toBe(zstdFile.byteLength); // copied, not moved

    const zlibFile = writeKtx2({
      vkFormat: R8G8B8A8_UNORM,
      width: 4,
      height: 4,
      scheme: 3,
      levels: await Promise.all(mipLevels.map((l) => deflate(l))),
      uncompressed: mipLevels.map((l) => l.byteLength),
    });
    const zlib = await decode(zlibFile, { workers });
    expect(zlib.levels.map((l) => [...(l as Uint8Array)])).toEqual(
      mipLevels.map((l) => [...l]),
    );
    expect(tasks).toEqual(['ktx2/inflate', 'ktx2/inflate']);
    // Uncompressed levels are not posted.
    await decode(mipmapped(), { workers });
    expect(tasks).toHaveLength(2);
  });

  it('fails with decode when the workers lack the decoder', async () => {
    const file = writeKtx2({
      vkFormat: R8G8B8A8_UNORM,
      width: 1,
      height: 1,
      scheme: 2,
      levels: [filled(5)],
      uncompressed: [4],
    });
    const error = await rejection(
      decode(file, { workers: workerPool().workers }, 'z.ktx2'),
    );
    expect(error.code).toBe('decode');
    expect(error.message).toContain('z.ktx2');
    expect(error.message).toContain('ktx2WorkerTasks({ zstd })');
  });
});

describe('Basis Universal', () => {
  const ETC1S = 163;
  const UASTC = 166;
  const blockBytes: Record<BasisTarget, number> = {
    bc7: 16,
    'astc-4x4': 16,
    etc2: 16,
    etc1: 8,
    rgba8: 64,
  };

  /** A transcoder of the tests: levels of the size of the target, recording its calls. */
  function fakeTranscoder() {
    const calls: { target: BasisTarget; kind: string; hasAlpha: boolean }[] =
      [];
    const transcoder: BasisTranscoder = {
      transcode(ktx2, target, { kind, hasAlpha }) {
        const ktx = parseKtx2(ktx2);
        calls.push({ target, kind, hasAlpha });
        const images = Math.max(ktx.layerCount, 1) * ktx.faceCount;
        return {
          levels: ktx.levels.map((_, level) => {
            const blocks =
              Math.ceil(Math.max(ktx.pixelWidth >> level, 1) / 4) *
              Math.ceil(Math.max(ktx.pixelHeight >> level, 1) / 4);
            return new Uint8Array(blocks * blockBytes[target] * images);
          }),
        };
      },
    };
    return { transcoder, calls };
  }

  // 8×8 with 2 levels, the data opaque to the codec.
  const etc1s = (alpha = false) =>
    writeKtx2({
      vkFormat: 0,
      width: 8,
      height: 8,
      scheme: 1,
      colorModel: ETC1S,
      channels: alpha ? [0, 15] : [0],
      levels: [filled(40), filled(10)],
      globalData: filled(32),
    });
  const uastc = (alpha: boolean) =>
    writeKtx2({
      vkFormat: 0,
      width: 4,
      height: 4,
      colorModel: UASTC,
      channels: [alpha ? 3 : 0],
      levels: [filled(16)],
    });

  it('keeps the file as universal data, transcoded later', async () => {
    const file = etc1s();
    const image = await decode(file);
    expect(image).toMatchObject({
      type: '2d',
      width: 8,
      height: 8,
      format: 'universal',
    });
    expect(image.levels[0].byteLength).toBe(file.byteLength);
    expect(image.transcode).toBeTypeOf('function');
  });

  it('picks the target among the formats of the backend: BC7, ASTC, ETC2 (ETC1 when opaque), else rgba8', () => {
    const pick = (
      formats: GpuTextureFormat[],
      kind: 'etc1s' | 'uastc' = 'etc1s',
      alpha = false,
    ) => basisTarget(formats, kind, alpha);
    expect(
      pick(['etc2-rgba8unorm', 'astc-4x4-unorm', 'bc7-rgba-unorm']),
    ).toEqual({ target: 'bc7', format: 'bc7-rgba-unorm' });
    expect(pick(['etc2-rgba8unorm', 'astc-4x4-unorm'])).toEqual({
      target: 'astc-4x4',
      format: 'astc-4x4-unorm',
    });
    expect(pick(['etc2-rgb8unorm', 'etc2-rgba8unorm'])).toEqual({
      target: 'etc1',
      format: 'etc2-rgb8unorm',
    });
    expect(pick(['etc2-rgb8unorm', 'etc2-rgba8unorm'], 'etc1s', true)).toEqual({
      target: 'etc2',
      format: 'etc2-rgba8unorm',
    });
    expect(pick(['etc2-rgb8unorm', 'etc2-rgba8unorm'], 'uastc')).toEqual({
      target: 'etc2',
      format: 'etc2-rgba8unorm',
    });
    expect(pick(['etc2-rgb8unorm'], 'etc1s', true)).toEqual({
      target: 'rgba8',
      format: 'rgba8unorm',
    });
    expect(pick([])).toEqual({ target: 'rgba8', format: 'rgba8unorm' });
  });

  it('transcodes with the transcoder of the application', async () => {
    const { transcoder, calls } = fakeTranscoder();
    const image = await decode(etc1s(true), { transcoder });
    const bc7 = await image.transcode!(['bc7-rgba-unorm', 'etc2-rgba8unorm']);
    expect(bc7.format).toBe('bc7-rgba-unorm');
    expect(bc7.levels.map((l) => l.byteLength)).toEqual([64, 16]);
    const rgba = await image.transcode!([]);
    expect(rgba.format).toBe('rgba8unorm');
    expect(rgba.levels.map((l) => l.byteLength)).toEqual([256, 64]);
    expect(calls).toEqual([
      { target: 'bc7', kind: 'etc1s', hasAlpha: true },
      { target: 'rgba8', kind: 'etc1s', hasAlpha: true },
    ]);

    const opaque = await decode(etc1s(false), { transcoder });
    expect(
      (await opaque.transcode!(['etc2-rgb8unorm', 'etc2-rgba8unorm'])).format,
    ).toBe('etc2-rgb8unorm');
    expect(calls.at(-1)).toEqual({
      target: 'etc1',
      kind: 'etc1s',
      hasAlpha: false,
    });
  });

  it('transcodes in the workers, the file kept for another backend', async () => {
    const { transcoder, calls } = fakeTranscoder();
    const { workers, tasks } = workerPool({ transcoder });
    const file = etc1s(true);
    const image = await decode(file, { workers });
    const bc7 = await image.transcode!(['bc7-rgba-unorm']);
    expect(bc7.format).toBe('bc7-rgba-unorm');
    expect(bc7.levels.map((l) => l.byteLength)).toEqual([64, 16]);
    const rgba = await image.transcode!([]);
    expect(rgba.levels.map((l) => l.byteLength)).toEqual([256, 64]);
    expect(image.levels[0].byteLength).toBe(file.byteLength);
    expect(calls).toEqual([
      { target: 'bc7', kind: 'etc1s', hasAlpha: true },
      { target: 'rgba8', kind: 'etc1s', hasAlpha: true },
    ]);
    expect(tasks).toEqual(['ktx2/transcode', 'ktx2/transcode']);

    // Aborted while in the worker: its result is dropped.
    const controller = new AbortController();
    const late = image.transcode!([], controller.signal);
    controller.abort();
    expect((await rejection(late)).code).toBe('aborted');

    const missing = await decode(file, { workers: workerPool().workers });
    const error = await rejection(missing.transcode!([]));
    expect(error.code).toBe('decode');
    expect(error.message).toContain('cannot transcode');
    expect((error.cause as Error).message).toContain(
      'ktx2WorkerTasks({ transcoder })',
    );
  });

  it('reads the alpha of UASTC data from its channel', async () => {
    const { transcoder, calls } = fakeTranscoder();
    await (
      await decode(uastc(true), { transcoder })
    ).transcode!(['astc-4x4-unorm']);
    await (
      await decode(uastc(false), { transcoder })
    ).transcode!(['astc-4x4-unorm']);
    expect(calls).toEqual([
      { target: 'astc-4x4', kind: 'uastc', hasAlpha: true },
      { target: 'astc-4x4', kind: 'uastc', hasAlpha: false },
    ]);
  });

  it('fails with unsupported without a transcoder, with decode for levels of the wrong size', async () => {
    const image = await decode(etc1s());
    const error = await rejection(image.transcode!(['bc7-rgba-unorm']));
    expect(error.code).toBe('unsupported');
    expect(error.message).toContain('transcoder');
    expect(supportsImage({}, image)).toBe(true);

    const wrong: BasisTranscoder = {
      transcode: () => ({ levels: [new Uint8Array(3), new Uint8Array(3)] }),
    };
    expect(
      (
        await rejection(
          (await decode(etc1s(), { transcoder: wrong })).transcode!([]),
        )
      ).code,
    ).toBe('decode');
  });
});

describe('textures from KTX2 files', () => {
  function setup(files: Record<string, Uint8Array>, options?: Ktx2Options) {
    const { backend, log } = fakeBackend();
    const store = new ResourceStore({ debounceMs: 0, warn: () => undefined });
    store.mount('mem', new MemorySource(files), { default: true });
    installKtx2(
      installAssets(store, { backend, warn: () => undefined }),
      options,
    );
    return { store, log };
  }

  it('creates the texture with the levels of the file', async () => {
    const { store, log } = setup({ 'a.ktx2': mipmapped() });
    const texture = await store.load<Texture>(TextureType, 'a.ktx2').ready;
    expect(texture).toMatchObject({ width: 4, height: 4, colorSpace: 'srgb' });
    expect(log.textures).toHaveLength(1);
    expect(log.textures[0]).toMatchObject({
      type: '2d',
      format: 'rgba8unorm-srgb',
      mipLevelCount: 3,
    });
    expect(log.textures[0].levels?.map((l) => l.byteLength)).toEqual([
      64, 16, 4,
    ]);
  });

  it('uploads a GPU compressed format as is, and transcodes universal data for the backend', async () => {
    const { transcoder, calls } = (() => {
      const calls: BasisTarget[] = [];
      const transcoder: BasisTranscoder = {
        transcode: (_, target) => {
          calls.push(target);
          return { levels: [new Uint8Array(16)] };
        },
      };
      return { transcoder, calls };
    })();
    const basis = writeKtx2({
      vkFormat: 0,
      width: 4,
      height: 4,
      scheme: 1,
      colorModel: 163,
      levels: [filled(8)],
    });
    const { store, log } = setup(
      { 'bc7.ktx2': bc7File(), 'basis.ktx2': basis },
      { transcoder },
    );
    await store.load(TextureType, 'bc7.ktx2', {
      options: { colorSpace: 'linear' },
    }).ready;
    await store.load<Texture>(TextureType, 'basis.ktx2').ready;
    expect(
      log.textures.map((t) => [t.format, t.mipLevelCount, t.levels?.length]),
    ).toEqual([
      ['bc7-rgba-unorm', 2, 2],
      ['bc7-rgba-unorm-srgb', 1, undefined],
    ]);
    expect(calls).toEqual(['bc7']);
  });

  it('reads the image through the codec registry', async () => {
    const { store } = setup({ 'a.ktx2': mipmapped() });
    const image: ImageAsset = await store.load(ImageAssetType, 'a.ktx2').ready;
    expect(image.levels).toHaveLength(3);
  });
});
