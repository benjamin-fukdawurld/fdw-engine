import type {
  GpuBackend,
  GpuBuffer,
  GpuBufferDescriptor,
  GpuTexture,
  GpuTextureDescriptor,
  GpuSampler,
  GpuSamplerDescriptor,
  GpuShaderModule,
  GpuShaderModuleDescriptor,
  GpuRenderPipeline,
  GpuRenderPipelineDescriptor,
  GpuComputePipeline,
  GpuComputePipelineDescriptor,
  GpuBindGroup,
  GpuBindGroupDescriptor,
  GpuBindGroupLayout,
  GpuBindGroupLayoutDescriptor,
  GpuCommandEncoder,
  GpuCommandBuffer,
  TextureFormat,
} from '@fdw/engine-backend';

import { WebGpuBuffer } from './webgpu-buffer';
import { WebGpuTexture } from './webgpu-texture';
import { WebGpuSampler } from './webgpu-sampler';
import { WebGpuShaderModule } from './webgpu-shader';
import { WebGpuRenderPipeline } from './webgpu-pipeline';
import { WebGpuComputePipeline } from './webgpu-compute-pipeline';
import { WebGpuBindGroupLayout, WebGpuBindGroup } from './webgpu-bind-group';
import { WebGpuCommandEncoder, WebGpuCommandBuffer } from './webgpu-command';

/**
 * WebGPU implementation of the {@link GpuBackend} abstraction.
 *
 * Manages the WebGPU device, canvas context, and serves as a factory
 * for all GPU resource types (buffers, textures, pipelines, etc.).
 */
export class WebGpuBackend implements GpuBackend {
  readonly name = 'webgpu';

  private _device!: GPUDevice;
  private _context!: GPUCanvasContext;
  private _format!: GPUTextureFormat;
  private _canvas!: HTMLCanvasElement;

  /** The underlying native WebGPU device. */
  get device(): GPUDevice {
    return this._device;
  }

  /** The canvas rendering context configured for WebGPU. */
  get context(): GPUCanvasContext {
    return this._context;
  }

  /**
   * Initialize the WebGPU backend.
   *
   * Requests a high-performance GPU adapter, obtains a device, and configures
   * the canvas context with the preferred texture format.
   *
   * @throws If WebGPU is not supported or no adapter is available.
   */
  async init(): Promise<void> {
    if (!navigator.gpu) {
      throw new Error('WebGPU is not supported in this browser');
    }

    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: 'high-performance',
    });
    if (!adapter) {
      throw new Error('Failed to get WebGPU adapter');
    }

    this._device = await adapter.requestDevice();
    this._format = navigator.gpu.getPreferredCanvasFormat();

    this._context.configure({
      device: this._device,
      format: this._format,
      alphaMode: 'premultiplied',
    });
  }

  /** Returns the preferred swap-chain texture format for this device. */
  getPreferredFormat(): TextureFormat {
    return this._format as unknown as TextureFormat;
  }

  /** Returns a view of the current swap-chain texture for this frame. */
  getCurrentTextureView(): GPUTextureView {
    return this._context.getCurrentTexture().createView();
  }

  /** Creates a GPU buffer and automatically adds `COPY_DST` usage. */
  createBuffer(descriptor: GpuBufferDescriptor): GpuBuffer {
    return new WebGpuBuffer(this._device, descriptor);
  }

  /** Creates a GPU texture. */
  createTexture(descriptor: GpuTextureDescriptor): GpuTexture {
    return new WebGpuTexture(this._device, descriptor);
  }

  /** Creates a GPU sampler with the given filtering and addressing modes. */
  createSampler(descriptor: GpuSamplerDescriptor): GpuSampler {
    return new WebGpuSampler(this._device, descriptor);
  }

  /** Creates a shader module from WGSL source code. */
  createShaderModule(descriptor: GpuShaderModuleDescriptor): GpuShaderModule {
    return new WebGpuShaderModule(this._device, descriptor);
  }

  /** Creates a bind group layout that describes resource binding shapes. */
  createBindGroupLayout(
    descriptor: GpuBindGroupLayoutDescriptor
  ): GpuBindGroupLayout {
    return new WebGpuBindGroupLayout(this._device, descriptor);
  }

  /** Creates a bind group that binds concrete resources to a layout. */
  createBindGroup(descriptor: GpuBindGroupDescriptor): GpuBindGroup {
    return new WebGpuBindGroup(this._device, descriptor);
  }

  /** Creates a render pipeline from vertex/fragment shaders and pipeline state. */
  createRenderPipeline(
    descriptor: GpuRenderPipelineDescriptor
  ): GpuRenderPipeline {
    return new WebGpuRenderPipeline(this._device, descriptor);
  }

  /** Creates a compute pipeline from a compute shader. */
  createComputePipeline(
    descriptor: GpuComputePipelineDescriptor
  ): GpuComputePipeline {
    return new WebGpuComputePipeline(this._device, descriptor);
  }

  /** Creates a command encoder to record GPU commands. */
  createCommandEncoder(label?: string): GpuCommandEncoder {
    return new WebGpuCommandEncoder(this._device, label);
  }

  /** Submits recorded command buffers to the GPU queue for execution. */
  submit(commandBuffers: GpuCommandBuffer[]): void {
    this._device.queue.submit(
      commandBuffers.map((cb) => (cb as WebGpuCommandBuffer)._native)
    );
  }

  /**
   * Resizes the canvas backing store.
   *
   * @param width - New width in physical pixels.
   * @param height - New height in physical pixels.
   */
  resize(width: number, height: number): void {
    this._canvas.width = width;
    this._canvas.height = height;
    // Context reconfiguration happens automatically on next getCurrentTexture()
  }

  /** Destroys the GPU device and releases all resources. */
  destroy(): void {
    this._device.destroy();
  }
}
