import {
  BackendCapabilities,
  BottomLevelDescriptor,
  CameraMath,
  GpuCommandBuffer,
  GpuCommandEncoder,
  GpuPassTimer,
  ObjectTableDescriptor,
  RenderBackend,
  RenderTargetDescriptor,
  TopLevelDescriptor,
  TransformMath,
  wgpuMatrixPrimitives,
} from '@fdw/engine-backend';
import {
  createBottomLevel,
  createTopLevel,
  unwrap,
  VulkanBottomLevel,
  VulkanCommandBuffer,
  VulkanCommandEncoder,
  VulkanObjectTable,
  VulkanPassTimer,
  VulkanPipelineFactory,
  VulkanTexture,
  VulkanTextureFactory,
  VulkanTopLevel,
} from '@fdw/engine-vulkan';
import { loadD3D12Addon } from '../addon';
import type { D3D12Device } from '../D3D12Device';

// The conventions of WebGPU, which are those of Direct3D: depth in [0, 1],
// y up in clip space and down in the viewport, column-major matrices.
const cameraMath = new CameraMath(wgpuMatrixPrimitives);
const transformMath = new TransformMath(wgpuMatrixPrimitives);

/**
 * The abstract rendering API on a Direct3D 12 device. The native library
 * has the API of the Vulkan one: the objects of the Vulkan backend
 * (buffers, textures, command encoder, object table, pass timer,
 * acceleration structures) serve as they are; the pipelines are generated
 * in HLSL for Direct3D 12.
 */
export class D3D12RenderBackend implements RenderBackend {
  readonly buffers;
  readonly textures: VulkanTextureFactory;
  readonly pipelines: VulkanPipelineFactory;
  readonly cameraMath = cameraMath;
  readonly transformMath = transformMath;
  // A 32-bit float depth.
  readonly depthFormat = 'depth24plus';
  readonly capabilities: BackendCapabilities;

  constructor(readonly device: D3D12Device) {
    const addon = loadD3D12Addon();
    this.buffers = device.buffers;
    this.textures = new VulkanTextureFactory(addon, device.context);
    this.capabilities = {
      renderableFormats: ['rgba16float'],
      // The BC formats (Direct3D has neither ETC2 nor ASTC).
      compressedFormats: this.textures.compressedFormats,
      // The object data in a table of structured buffers.
      objectTable: true,
      maxAnisotropy: addon.maxAnisotropy(device.context),
      maxColorAttachments: addon.maxColorAttachments(device.context),
      independentBlend: addon.independentBlend(device.context),
      // Ray queries in every stage and the ray tracing pipelines, where the
      // GPU has DXR 1.1.
      rayQuery: addon.rayQuerySupported(device.context),
      rayTracingPipeline: addon.rayTracingPipelineSupported(device.context),
    };
    this.pipelines = new VulkanPipelineFactory(addon, device.context, {
      target: 'd3d12',
    });
  }

  createRenderTarget({
    width,
    height,
    format,
    label,
  }: RenderTargetDescriptor): VulkanTexture {
    return this.textures.createTexture({
      type: '2d',
      format,
      dimensions: { width, height },
      usage: ['render-attachment', 'sampled', 'copy-src', 'copy-dst'],
      ...(label ? { label } : {}),
    });
  }

  createCommandEncoder(): GpuCommandEncoder {
    return new VulkanCommandEncoder();
  }

  createObjectTable(descriptor: ObjectTableDescriptor): VulkanObjectTable {
    return new VulkanObjectTable(this.buffers, descriptor);
  }

  // The acceleration structures of the GPU, where it has ray queries.
  createBottomLevel(descriptor: BottomLevelDescriptor): VulkanBottomLevel {
    return createBottomLevel(loadD3D12Addon(), this.device.context, descriptor);
  }

  createTopLevel(descriptor?: TopLevelDescriptor): VulkanTopLevel {
    return createTopLevel(loadD3D12Addon(), this.device.context, descriptor);
  }

  // Where the queue writes timestamps.
  createPassTimer(capacity: number): GpuPassTimer | undefined {
    const addon = loadD3D12Addon();
    return addon.timestampsSupported(this.device.context)
      ? new VulkanPassTimer(addon, this.device.context, capacity)
      : undefined;
  }

  submit(commands: readonly GpuCommandBuffer[]): void {
    const addon = loadD3D12Addon();
    for (const command of commands) {
      addon.submit(
        this.device.context,
        unwrap(command, VulkanCommandBuffer, 'The command buffer').words,
      );
    }
  }
}
