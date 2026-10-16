import type { ResourceBytes } from '@fdw/engine-resources';
import type { GltfJson } from './types';

// The binary container of glTF: a 12-byte header, a JSON chunk, then an
// optional BIN chunk holding the buffer 0 of the file.

const MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'

/** Whether the bytes start with the magic of a GLB file: the `sniff` of the loader. */
export const isGlb = (head: Uint8Array): boolean =>
  head.length >= 4 &&
  head[0] === 0x67 &&
  head[1] === 0x6c &&
  head[2] === 0x54 &&
  head[3] === 0x46;

export interface GlbContent {
  readonly json: GltfJson;
  /** The BIN chunk: a view into the bytes of the file, not a copy. */
  readonly bin?: Uint8Array<ArrayBuffer>;
}

/** Splits a GLB file into its JSON and its BIN chunk. Throws on a malformed file. */
export function parseGlb(bytes: ResourceBytes): GlbContent {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== MAGIC)
    throw new Error('Not a GLB file');
  const version = view.getUint32(4, true);
  if (version !== 2) throw new Error(`GLB version ${version} is not supported`);
  const length = Math.min(view.getUint32(8, true), bytes.byteLength);
  let json: GltfJson | undefined;
  let bin: Uint8Array<ArrayBuffer> | undefined;
  for (let offset = 12; offset + 8 <= length;) {
    const size = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + size > length) throw new Error('Truncated GLB chunk');
    const chunk = bytes.subarray(start, start + size);
    if (type === CHUNK_JSON && !json)
      json = JSON.parse(new TextDecoder().decode(chunk)) as GltfJson;
    else if (type === CHUNK_BIN && !bin) bin = chunk;
    // Unknown chunks are skipped, as the specification asks.
    offset = start + size + ((4 - (size % 4)) % 4);
  }
  if (!json) throw new Error('GLB file without a JSON chunk');
  return { json, bin };
}

/**
 * The bytes of a `data:` URI (the base64 buffers and images of a `.gltf`),
 * decoded here rather than by a `DataUriSource`: the file works whether or
 * not the application mounted one. Undefined for any other URI.
 */
export function decodeDataUri(uri: string): ResourceBytes | undefined {
  if (!uri.startsWith('data:')) return undefined;
  const comma = uri.indexOf(',');
  if (comma < 0) throw new Error('Malformed data URI');
  const payload = uri.slice(comma + 1);
  if (/;base64$/i.test(uri.slice(0, comma))) {
    const bin = atob(
      payload.includes('%') ? decodeURIComponent(payload) : payload,
    );
    return Uint8Array.from(bin, (c) => c.charCodeAt(0)) as ResourceBytes;
  }
  return new TextEncoder().encode(decodeURIComponent(payload)) as ResourceBytes;
}
