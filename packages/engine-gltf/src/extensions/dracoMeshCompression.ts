import type { GltfExtension } from '../extension';

/**
 * `KHR_draco_mesh_compression`: primitives compressed by Draco, decoded by
 * `options.draco` (a `DracoDecoder` the application writes over `draco3d`).
 */
export const KHR_draco_mesh_compression: GltfExtension = {
  name: 'KHR_draco_mesh_compression',
  prepare: (context) => context.options.draco !== undefined,
  async primitive(ext, _primitive, context) {
    const { bufferView, attributes } = ext as {
      bufferView: number;
      attributes: Record<string, number>;
    };
    return context.options.draco!.decode(
      await context.bufferView(bufferView),
      attributes
    );
  },
};
