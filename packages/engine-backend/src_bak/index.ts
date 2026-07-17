/**
 * @fdw/engine-backend
 *
 * Hardware-agnostic GPU abstraction layer.
 * Defines interfaces for Device, Buffer, Texture, Pipeline, RenderPass, etc.
 * Implementations (WebGPU, WebGL, Vulkan...) live in separate packages.
 */

// ─── Device & Capabilities ─────────────────────────────────────────────────
export { GpuDevice } from './GpuDevice';
export type { GpuDeviceDescriptor, GpuDeviceLimits } from './GpuDevice';

// ─── Buffers ────────────────────────────────────────────────────────────────
export { BufferUsage } from './buffer';
export type { GpuBuffer, GpuBufferDescriptor } from './buffer';

// ─── Textures ───────────────────────────────────────────────────────────────
export { TextureUsage } from './texture';
export type {
  TextureFormat,
  GpuTexture,
  GpuTextureDescriptor,
  GpuSampler,
  GpuSamplerDescriptor,
} from './texture';

// ─── Shaders & Pipelines ────────────────────────────────────────────────────
export type { GpuShaderModule, GpuShaderModuleDescriptor } from './shader';
export type {
  PrimitiveTopology,
  CullMode,
  FrontFace,
  CompareFunction,
  GpuRenderPipeline,
  GpuRenderPipelineDescriptor,
  VertexBufferLayout,
  VertexAttribute,
  VertexFormat,
  DepthStencilState,
  ColorTargetState,
  BlendState,
} from './pipeline';
export type {
  GpuComputePipeline,
  GpuComputePipelineDescriptor,
} from './compute-pipeline';

// ─── Bind Groups ────────────────────────────────────────────────────────────
export type {
  GpuBindGroup,
  GpuBindGroupDescriptor,
  GpuBindGroupLayout,
  GpuBindGroupLayoutDescriptor,
  BindGroupEntry,
  BindGroupLayoutEntry,
} from './bind-group';

// ─── Render Pass ────────────────────────────────────────────────────────────
export type {
  GpuRenderPass,
  GpuRenderPassDescriptor,
  ColorAttachment,
  DepthStencilAttachment,
} from './render-pass';

// ─── Compute Pass ───────────────────────────────────────────────────────────
export type { GpuComputePass } from './GpuComputePass';

// ─── Command Encoding ───────────────────────────────────────────────────────
export type { GpuCommandEncoder, GpuCommandBuffer } from './command';

// ─── Backend Factory ────────────────────────────────────────────────────────
export type { GpuBackend } from './GpuBackend';
