/**
 * GpuBackend — Factory interface that each implementation must provide.
 *
 * This is the single entry point to create a backend. The engine-core
 * depends only on this interface, never on a concrete implementation.
 */

import type { GpuBuffer, GpuBufferDescriptor } from './buffer';
import type {
  GpuTexture,
  GpuTextureDescriptor,
  GpuSampler,
  GpuSamplerDescriptor,
} from './texture';
import type { GpuShaderModule, GpuShaderModuleDescriptor } from './shader';
import type {
  GpuRenderPipeline,
  GpuRenderPipelineDescriptor,
} from './pipeline';
import type {
  GpuComputePipeline,
  GpuComputePipelineDescriptor,
} from './compute-pipeline';
import type {
  GpuBindGroup,
  GpuBindGroupDescriptor,
  GpuBindGroupLayout,
  GpuBindGroupLayoutDescriptor,
} from './bind-group';
import type { GpuCommandEncoder } from './command';
import type { TextureFormat } from './texture';

export interface GpuBackend {
  readonly name: string;

  /**
   * Initialize the backend.
   */
  init(): Promise<void>;

  /** @returns The preferred swap-chain texture format for this device. */
  getPreferredFormat(): TextureFormat;

  /** @returns A view of the current swap-chain texture (call once per frame). */
  getCurrentTextureView(): unknown;

  /**
   * Create a GPU buffer.
   *
   * @param descriptor - Buffer size, usage, and optional label.
   * @returns The created buffer.
   */
  createBuffer(descriptor: GpuBufferDescriptor): GpuBuffer;

  /**
   * Create a GPU texture.
   *
   * @param descriptor - Texture dimensions, format, and usage.
   * @returns The created texture.
   */
  createTexture(descriptor: GpuTextureDescriptor): GpuTexture;

  /**
   * Create a sampler.
   *
   * @param descriptor - Filtering and addressing modes.
   * @returns The created sampler.
   */
  createSampler(descriptor: GpuSamplerDescriptor): GpuSampler;

  /**
   * Create a shader module.
   *
   * @param descriptor - Shader source code (WGSL).
   * @returns The compiled shader module.
   */
  createShaderModule(descriptor: GpuShaderModuleDescriptor): GpuShaderModule;

  /**
   * Create a bind group layout.
   *
   * @param descriptor - Binding shapes (indices, visibility, resource types).
   * @returns The created layout.
   */
  createBindGroupLayout(
    descriptor: GpuBindGroupLayoutDescriptor
  ): GpuBindGroupLayout;

  /**
   * Create a bind group.
   *
   * @param descriptor - Concrete resource bindings matching a layout.
   * @returns The created bind group.
   */
  createBindGroup(descriptor: GpuBindGroupDescriptor): GpuBindGroup;

  /**
   * Create a render pipeline.
   *
   * @param descriptor - Full pipeline state (shaders, vertex layout, blend, depth).
   * @returns The created pipeline.
   */
  createRenderPipeline(
    descriptor: GpuRenderPipelineDescriptor
  ): GpuRenderPipeline;

  /**
   * Create a compute pipeline.
   *
   * @param descriptor - Compute shader and bind group layouts.
   * @returns The created compute pipeline.
   */
  createComputePipeline(
    descriptor: GpuComputePipelineDescriptor
  ): GpuComputePipeline;

  /**
   * Create a command encoder to record GPU commands.
   *
   * @param label - Optional debug label.
   * @returns A new command encoder.
   */
  createCommandEncoder(label?: string): GpuCommandEncoder;

  /**
   * Submit recorded command buffers for execution.
   *
   * @param commandBuffers - The command buffers to submit.
   */
  submit(commandBuffers: import('./command').GpuCommandBuffer[]): void;

  /**
   * Resize the swap-chain.
   *
   * @param width - New width in physical pixels.
   * @param height - New height in physical pixels.
   */
  resize(width: number, height: number): void;

  /** Destroy the backend and release all resources */
  destroy(): void;
}
