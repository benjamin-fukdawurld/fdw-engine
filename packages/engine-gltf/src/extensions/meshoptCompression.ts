import { runTask } from '@fdw/engine-resources';
import type { GltfExtension } from '../extension';
import { gltfTasks, type MeshoptJob } from '../workers';

interface MeshoptBufferView {
  readonly buffer: number;
  readonly byteOffset?: number;
  readonly byteLength: number;
  readonly byteStride: number;
  readonly count: number;
  readonly mode: 'ATTRIBUTES' | 'TRIANGLES' | 'INDICES';
  readonly filter?:
    'NONE' | 'OCTAHEDRAL' | 'QUATERNION' | 'EXPONENTIAL' | 'COLOR';
}

/**
 * `EXT_meshopt_compression`: buffer views compressed by meshoptimizer,
 * decoded by `options.meshopt` (the `MeshoptDecoder` of the package), or in
 * the workers of `options.workers`, whose script has the decoder. The
 * uncompressed fallback buffers, when the file has some, are never read.
 */
export const EXT_meshopt_compression: GltfExtension = {
  name: 'EXT_meshopt_compression',
  async prepare(context) {
    if (context.options.workers) return true;
    const decoder = context.options.meshopt;
    if (!decoder) return false;
    await decoder.ready;
    return true;
  },
  async bufferView(ext, _view, context) {
    const {
      buffer,
      byteOffset = 0,
      byteLength,
      byteStride,
      count,
      mode,
      filter,
    } = ext as MeshoptBufferView;
    const source = (await context.buffer(buffer)).subarray(
      byteOffset,
      byteOffset + byteLength,
    );
    const { workers } = context.options;
    if (workers) {
      // A copy: the file stays here.
      const job: MeshoptJob = {
        source: source.slice(),
        count,
        size: byteStride,
        mode,
        filter,
      };
      return runTask<Uint8Array<ArrayBuffer>>(workers, gltfTasks.meshopt, job, {
        transfer: [job.source.buffer],
        signal: context.signal,
      });
    }
    const target = new Uint8Array(count * byteStride);
    context.options.meshopt!.decodeGltfBuffer(
      target,
      count,
      byteStride,
      source,
      mode,
      filter,
    );
    return target;
  },
};
