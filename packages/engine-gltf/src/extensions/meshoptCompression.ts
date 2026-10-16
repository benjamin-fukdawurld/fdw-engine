import type { GltfExtension } from '../extension';

interface MeshoptBufferView {
  readonly buffer: number;
  readonly byteOffset?: number;
  readonly byteLength: number;
  readonly byteStride: number;
  readonly count: number;
  readonly mode: 'ATTRIBUTES' | 'TRIANGLES' | 'INDICES';
  readonly filter?:
    | 'NONE'
    | 'OCTAHEDRAL'
    | 'QUATERNION'
    | 'EXPONENTIAL'
    | 'COLOR';
}

/**
 * `EXT_meshopt_compression`: buffer views compressed by meshoptimizer,
 * decoded by `options.meshopt` (the `MeshoptDecoder` of the package). The
 * uncompressed fallback buffers, when the file has some, are never read.
 */
export const EXT_meshopt_compression: GltfExtension = {
  name: 'EXT_meshopt_compression',
  async prepare(context) {
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
      byteOffset + byteLength
    );
    const target = new Uint8Array(count * byteStride);
    context.options.meshopt!.decodeGltfBuffer(
      target,
      count,
      byteStride,
      source,
      mode,
      filter
    );
    return target;
  },
};
