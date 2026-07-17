/**
 * @fdw/engine-webgpu
 *
 * WebGPU implementation of the @fdw/engine-backend abstraction.
 */

export { WebGpuBackend } from './WebGpuBackend';
export { WebGpuSceneRenderer } from './renderer/webgpu-scene-renderer';
export type {
  TessellatedMeshEntry,
  EdgeOverlayEntry,
} from './renderer/webgpu-scene-renderer';
