import { runTask } from '@fdw/engine-resources';
import type { GltfDecodedPrimitive, GltfExtension } from '../extension';
import { gltfTasks, type DracoJob } from '../workers';

/**
 * `KHR_draco_mesh_compression`: primitives compressed by Draco, decoded by
 * `options.draco` (a `DracoDecoder` the application writes over `draco3d`),
 * or in the workers of `options.workers`, whose script has the decoder.
 */
export const KHR_draco_mesh_compression: GltfExtension = {
  name: 'KHR_draco_mesh_compression',
  prepare: (context) =>
    context.options.draco !== undefined ||
    context.options.workers !== undefined,
  async primitive(ext, _primitive, context) {
    const { bufferView, attributes } = ext as {
      bufferView: number;
      attributes: Record<string, number>;
    };
    const bytes = await context.bufferView(bufferView);
    const { workers } = context.options;
    if (workers) {
      // A copy: the file stays here.
      const job: DracoJob = { bytes: bytes.slice(), attributes };
      return runTask<GltfDecodedPrimitive>(workers, gltfTasks.draco, job, {
        transfer: [job.bytes.buffer],
        signal: context.signal,
      });
    }
    return context.options.draco!.decode(bytes, attributes);
  },
};
