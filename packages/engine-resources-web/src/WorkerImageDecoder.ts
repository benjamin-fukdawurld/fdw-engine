import {
  runTask,
  type ResourceBytes,
  type WorkerTasks,
} from '@fdw/engine-resources';
import { createImageBitmapDecoder } from './BitmapImageDecoder';
import type {
  DecodedImage,
  ImageDecodeOptions,
  ImageDecoder,
} from './ImageDecoder';
import { serveWorker, type WorkerPool, type WorkerScope } from './WorkerPool';

interface DecodeRequest {
  readonly bytes: ResourceBytes;
  readonly mimeType?: string;
}

export interface WorkerImageDecoderOptions {
  /**
   * Moves the buffer to the worker instead of copying it: free, but the
   * caller's `bytes` become empty. On by default; turn it off when the bytes
   * are used again afterwards.
   */
  readonly transferBytes?: boolean;
  /**
   * The workers serve tasks by name (`taskHandler`), the decoding of images
   * among others: the job is the task of `imageWorkerTasks`. One pool then
   * decodes images, glTF and KTX2. Off by default: the script of
   * `createImageDecoderWorker`.
   */
  readonly shared?: boolean;
}

/** The name of the task of `imageWorkerTasks`. */
export const imageDecodeTask = 'image/decode';

/** Decodes in a worker of the pool: the main thread only receives the bitmap. */
export function createWorkerImageDecoder(
  pool: WorkerPool,
  { transferBytes = true, shared = false }: WorkerImageDecoderOptions = {},
): ImageDecoder {
  return {
    decode(
      bytes: ResourceBytes,
      { signal, mimeType }: ImageDecodeOptions = {},
    ): Promise<DecodedImage> {
      const request: DecodeRequest = { bytes, mimeType };
      const options = {
        transfer: transferBytes ? [bytes.buffer] : undefined,
        signal,
        discard: (image: DecodedImage) => image.bitmap.close(),
      };
      return shared
        ? runTask<DecodedImage>(pool, imageDecodeTask, request, options)
        : pool.run<DecodedImage>(request, options);
    },
  };
}

/** The task of `createWorkerImageDecoder(pool, { shared: true })`, for `taskHandler`. */
export function imageWorkerTasks(
  decoder: ImageDecoder = createImageBitmapDecoder(),
): WorkerTasks {
  return {
    [imageDecodeTask]: async ({ bytes, mimeType }: DecodeRequest) => {
      const image = await decoder.decode(bytes, { mimeType });
      return { result: image, transfer: [image.bitmap] };
    },
  };
}

/** The worker script of `createWorkerImageDecoder`: `serveImageDecoder()`. */
export function serveImageDecoder(
  scope?: WorkerScope,
  decoder: ImageDecoder = createImageBitmapDecoder(),
): void {
  serveWorker<DecodeRequest, DecodedImage>(async ({ bytes, mimeType }) => {
    const image = await decoder.decode(bytes, { mimeType });
    return { result: image, transfer: [image.bitmap] };
  }, scope);
}

/** A worker running `serveImageDecoder`, for `new WorkerPool({ create })`. */
export const createImageDecoderWorker = (): Worker =>
  new Worker(new URL('./imageDecoder.worker.ts', import.meta.url), {
    type: 'module',
  });
