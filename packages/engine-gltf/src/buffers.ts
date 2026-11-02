import {
  defineResourceType,
  type LoadContext,
  type ResourceBytes,
  type ResourceLoader,
} from '@fdw/engine-resources';
import { decodeDataUri } from './glb';
import type { GltfJson } from './types';

/**
 * The external buffers of a `.gltf` (`scene.bin`): resources of their own,
 * so two files sharing one read it once, and a load cancelled cancels it.
 */
export const BufferType = defineResourceType<ResourceBytes>('buffer');

export const bufferLoader: ResourceLoader<ResourceBytes> = {
  type: BufferType,
  load: (ctx) => ctx.bytes(),
  sizeOf: (bytes) => bytes.byteLength,
};

// The URIs of glTF are percent-encoded (`my%20texture.png`); the sources
// take plain paths.
export const decodeUri = (uri: string): string => {
  try {
    return decodeURIComponent(uri);
  } catch {
    return uri;
  }
};

/** A reader by index, each index read once. */
export const memoize = <T>(read: (index: number) => Promise<T>) => {
  const cache = new Map<number, Promise<T>>();
  return (index: number): Promise<T> => {
    let promise = cache.get(index);
    if (!promise) cache.set(index, (promise = read(index)));
    return promise;
  };
};

const isOffset = (value: number) => Number.isSafeInteger(value) && value >= 0;

/**
 * The buffers and buffer views of a file, each read once: the BIN chunk of
 * a GLB, data URIs, external files (dependencies of the load: shared,
 * cancelled with it). A buffer view is checked against its buffer; its
 * compression is the caller's (`GltfReader` applies the extensions).
 */
export function fileBuffers(
  ctx: LoadContext<unknown>,
  json: GltfJson,
  bin: Uint8Array<ArrayBuffer> | undefined,
): {
  readonly buffer: (index: number) => Promise<Uint8Array<ArrayBuffer>>;
  readonly bufferView: (index: number) => Promise<Uint8Array<ArrayBuffer>>;
} {
  const buffer = memoize(async (index) => {
    const b = json.buffers?.[index];
    if (!b) throw new Error(`Missing buffer ${index}`);
    if (b.uri === undefined) {
      if (index === 0 && bin) return bin;
      throw new Error(`Buffer ${index} has no data`);
    }
    return (
      decodeDataUri(b.uri) ??
      ctx.use(BufferType, ctx.resolve(decodeUri(b.uri))).ready
    );
  });
  const bufferView = memoize(async (index) => {
    const view = json.bufferViews?.[index];
    if (!view) throw new Error(`Missing buffer view ${index}`);
    const start = view.byteOffset ?? 0;
    if (!isOffset(start) || !isOffset(view.byteLength))
      throw new Error(`Buffer view ${index} has an invalid range`);
    const bytes = await buffer(view.buffer);
    if (start + view.byteLength > bytes.byteLength)
      throw new Error(`Buffer view ${index} out of its buffer`);
    return bytes.subarray(start, start + view.byteLength);
  });
  return { buffer, bufferView };
}
