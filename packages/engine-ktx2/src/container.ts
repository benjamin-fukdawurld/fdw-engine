import { ResourceError } from '@fdw/engine-resources';

/** The 12 bytes a KTX2 file starts with: `«KTX 20»\r\n\x1A\n`. */
export const KTX2_IDENTIFIER = new Uint8Array([
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** Whether bytes start with the KTX2 identifier. */
export const isKtx2 = (head: Uint8Array): boolean =>
  head.length >= KTX2_IDENTIFIER.length &&
  KTX2_IDENTIFIER.every((byte, i) => head[i] === byte);

/** The supercompression schemes of the KTX2 specification. */
export const Ktx2Supercompression = {
  none: 0,
  basisLZ: 1,
  zstd: 2,
  zlib: 3,
} as const;

/** The color models of a Data Format Descriptor that matter here. */
export const Ktx2ColorModel = { etc1s: 163, uastc: 166 } as const;

export interface Ktx2Level {
  /** Where the data of the level is, in the file. */
  readonly byteOffset: number;
  readonly byteLength: number;
  /** Its size once inflated (that of `byteLength` without supercompression). */
  readonly uncompressedByteLength: number;
}

/** A sample of the basic Data Format Descriptor block: a channel and its bits. */
export interface Ktx2Sample {
  readonly bitOffset: number;
  readonly bitLength: number;
  /** The channel identifier (`KHR_DF_CHANNEL_*`), without the flags. */
  readonly channelId: number;
  /** The flags of the channel: float, signed, exponent, linear (alpha in sRGB). */
  readonly qualifiers: number;
}

/** The basic block of the Data Format Descriptor. */
export interface Ktx2DataFormat {
  readonly colorModel: number;
  readonly colorPrimaries: number;
  /** 2 for sRGB (`KHR_DF_TRANSFER_SRGB`), 1 for linear. */
  readonly transferFunction: number;
  readonly flags: number;
  readonly samples: readonly Ktx2Sample[];
}

/** The parts of a KTX2 file, without the data of its levels decoded. */
export interface Ktx2Container {
  /** 0 (`VK_FORMAT_UNDEFINED`) for the Basis Universal data. */
  readonly vkFormat: number;
  readonly typeSize: number;
  readonly pixelWidth: number;
  /** 0 for a 1D texture. */
  readonly pixelHeight: number;
  /** 0 except for a 3D texture. */
  readonly pixelDepth: number;
  /** 0 except for an array. */
  readonly layerCount: number;
  /** 6 for a cube, 1 otherwise. */
  readonly faceCount: number;
  /** As in the file: 0 asks for the levels to be generated (one level is stored). */
  readonly levelCount: number;
  readonly supercompressionScheme: number;
  /** Level 0 (the largest) first, as the level index of the file (the data is stored the smallest first). */
  readonly levels: readonly Ktx2Level[];
  readonly dataFormat: Ktx2DataFormat;
  /** The key/value data: `KTXorientation`, `KTXwriter`… as stored (the strings end with a NUL). */
  readonly keyValues: ReadonlyMap<string, Uint8Array>;
  /** The supercompression global data (that of BasisLZ). */
  readonly globalData: Uint8Array;
}

const HEADER_SIZE = 80;
const LEVEL_SIZE = 24;
const textDecoder = new TextDecoder();

/**
 * Reads the header, the level index, the Data Format Descriptor, the
 * key/value data and the supercompression global data of a KTX2 file.
 * Throws a `ResourceError('decode')` for a file that is not one, or that
 * points outside of itself.
 */
export function parseKtx2(bytes: Uint8Array, uri = 'ktx2'): Ktx2Container {
  const fail = (message: string) =>
    new ResourceError('decode', uri, `${uri}: ${message}`);
  if (!isKtx2(bytes)) throw fail('not a KTX2 file');
  if (bytes.byteLength < HEADER_SIZE) throw fail('truncated header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (offset: number) => view.getUint32(offset, true);
  const u64 = (offset: number) => {
    const value = view.getBigUint64(offset, true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER))
      throw fail('offset out of range');
    return Number(value);
  };
  const range = (offset: number, length: number, what: string) => {
    if (offset + length > bytes.byteLength)
      throw fail(`${what} outside of the file`);
    return bytes.subarray(offset, offset + length);
  };

  const levelCount = u32(40);
  const levels: Ktx2Level[] = [];
  for (let i = 0; i < Math.max(levelCount, 1); i++) {
    const at = HEADER_SIZE + i * LEVEL_SIZE;
    if (at + LEVEL_SIZE > bytes.byteLength) throw fail('truncated level index');
    const level = {
      byteOffset: u64(at),
      byteLength: u64(at + 8),
      uncompressedByteLength: u64(at + 16),
    };
    range(level.byteOffset, level.byteLength, `level ${i}`);
    levels.push(level);
  }

  return {
    vkFormat: u32(12),
    typeSize: u32(16),
    pixelWidth: u32(20),
    pixelHeight: u32(24),
    pixelDepth: u32(28),
    layerCount: u32(32),
    faceCount: u32(36),
    levelCount,
    supercompressionScheme: u32(44),
    levels,
    dataFormat: parseDataFormat(
      range(u32(48), u32(52), 'data format descriptor'),
      fail,
    ),
    keyValues: parseKeyValues(range(u32(56), u32(60), 'key/value data')),
    globalData: range(u64(64), u64(72), 'supercompression global data'),
  };
}

function parseDataFormat(
  dfd: Uint8Array,
  fail: (message: string) => Error,
): Ktx2DataFormat {
  // The total size, then the basic block: its header is 24 bytes, then 16 per sample.
  if (dfd.byteLength < 28) throw fail('truncated data format descriptor');
  const view = new DataView(dfd.buffer, dfd.byteOffset, dfd.byteLength);
  const blockSize = view.getUint16(4 + 6, true);
  const sampleCount = Math.max(
    0,
    Math.floor((Math.min(blockSize, dfd.byteLength - 4) - 24) / 16),
  );
  const samples: Ktx2Sample[] = [];
  for (let i = 0; i < sampleCount; i++) {
    const at = 4 + 24 + i * 16;
    const channel = view.getUint8(at + 3);
    samples.push({
      bitOffset: view.getUint16(at, true),
      bitLength: view.getUint8(at + 2) + 1,
      channelId: channel & 0x0f,
      qualifiers: channel & 0xf0,
    });
  }
  return {
    colorModel: view.getUint8(4 + 8),
    colorPrimaries: view.getUint8(4 + 9),
    transferFunction: view.getUint8(4 + 10),
    flags: view.getUint8(4 + 11),
    samples,
  };
}

function parseKeyValues(kvd: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(kvd.buffer, kvd.byteOffset, kvd.byteLength);
  const values = new Map<string, Uint8Array>();
  let at = 0;
  while (at + 4 <= kvd.byteLength) {
    const length = view.getUint32(at, true);
    const pair = kvd.subarray(
      at + 4,
      Math.min(at + 4 + length, kvd.byteLength),
    );
    const nul = pair.indexOf(0);
    if (nul > 0) {
      values.set(
        textDecoder.decode(pair.subarray(0, nul)),
        pair.subarray(nul + 1),
      );
    }
    at += 4 + Math.ceil(length / 4) * 4;
  }
  return values;
}
