import type { GltfExtension } from '../extension';

/**
 * `KHR_mesh_quantization`: attributes in normalized or integer types. There
 * is nothing to do but to accept it: the vertex formats map them already
 * (`snorm16x4`, `unorm8x4`…), and the node transforms dequantize them.
 */
export const KHR_mesh_quantization: GltfExtension = {
  name: 'KHR_mesh_quantization',
};
