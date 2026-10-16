import { buffersOf, owned, type WorkerTasks } from '@fdw/engine-resources';
import type {
  BasisTarget,
  BasisTranscoder,
  BasisTranscodeOptions,
  ZstdDecoder,
} from './codec';
import { Ktx2Supercompression } from './container';

// The decoding of KTX2 in the workers of `Ktx2Options.workers`: the jobs
// posted by the codec, and the tasks of the worker script that answer them
// (`ktx2WorkerTasks`, from `@fdw/engine-ktx2/worker`, which imports nothing
// of the engine but its decoders).

/** The names of the tasks of `ktx2WorkerTasks`. */
export const ktx2Tasks = {
  inflate: 'ktx2/inflate',
  transcode: 'ktx2/transcode',
} as const;

export interface InflateJob {
  /** zlib or zstd. */
  readonly scheme: number;
  /** The supercompressed levels, with their size once inflated. */
  readonly levels: readonly {
    readonly bytes: Uint8Array<ArrayBuffer>;
    readonly uncompressedSize: number;
  }[];
}

export interface TranscodeJob extends Omit<BasisTranscodeOptions, 'signal'> {
  readonly ktx2: Uint8Array<ArrayBuffer>;
  readonly target: BasisTarget;
}

/** zlib, with the `DecompressionStream` of the browsers and of Node. */
export async function inflate(
  data: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([data])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** What the worker script decodes with: the decoders the files need. */
export interface Ktx2WorkerOptions {
  /** For the Basis Universal data: a `BasisTranscoder` over `basis_transcoder`, built in the worker. */
  readonly transcoder?: BasisTranscoder;
  /** For the zstd supercompression of the files in a GPU format. */
  readonly zstd?: ZstdDecoder;
}

/**
 * The tasks of the KTX2 codec for `taskHandler`, in the worker script of
 * the pool given as `Ktx2Options.workers`: the inflating of the levels
 * (zlib, zstd) and the transcoding of Basis Universal data.
 *
 * ```ts
 * import { taskHandler } from '@fdw/engine-resources';
 * import { serveWorker } from '@fdw/engine-resources-web';
 * import { ktx2WorkerTasks } from '@fdw/engine-ktx2/worker';
 *
 * serveWorker(taskHandler(ktx2WorkerTasks({ transcoder, zstd })));
 * ```
 */
export function ktx2WorkerTasks({
  transcoder,
  zstd,
}: Ktx2WorkerOptions = {}): WorkerTasks {
  return {
    [ktx2Tasks.inflate]: async ({ scheme, levels }: InflateJob) => {
      if (scheme === Ktx2Supercompression.zstd && !zstd)
        throw new Error(
          'zstd supercompression needs a decoder: ktx2WorkerTasks({ zstd })',
        );
      const result: Uint8Array<ArrayBuffer>[] = [];
      for (const { bytes, uncompressedSize } of levels) {
        try {
          result.push(
            scheme === Ktx2Supercompression.zlib
              ? await inflate(bytes)
              : owned(
                  (await zstd!.decode(
                    bytes,
                    uncompressedSize,
                  )) as Uint8Array<ArrayBuffer>,
                ),
          );
        } catch (e) {
          throw new Error(
            `cannot inflate level ${result.length}: ${(e as Error).message}`,
            { cause: e },
          );
        }
      }
      return { result, transfer: buffersOf(result) };
    },
    [ktx2Tasks.transcode]: async ({
      ktx2,
      target,
      kind,
      hasAlpha,
    }: TranscodeJob) => {
      if (!transcoder)
        throw new Error(
          'Basis Universal data needs a transcoder: ktx2WorkerTasks({ transcoder })',
        );
      const { levels } = await transcoder.transcode(ktx2, target, {
        kind,
        hasAlpha,
      });
      const result = levels.map((level) =>
        owned(level as Uint8Array<ArrayBuffer>),
      );
      return { result, transfer: buffersOf(result) };
    },
  };
}
