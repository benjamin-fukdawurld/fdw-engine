import {
  BackendCapabilities,
  CameraMath,
  GpuCommandBuffer,
  GpuCommandEncoder,
  RenderBackend,
  RenderTargetDescriptor,
  TransformMath,
  wgpuMatrixPrimitives,
  GpuPassTimer,
  ObjectTableDescriptor,
  BottomLevelDescriptor,
  TopLevelDescriptor,
} from '@fdw/engine-backend';
import {
  createBottomLevel,
  createTopLevel,
  VulkanBottomLevel,
  VulkanTopLevel,
} from './VulkanAccelerationStructures';
import { loadVulkanAddon } from '../addon';
import { VulkanTexture, VulkanTextureFactory } from '../gpu/VulkanTexture';
import type { VulkanDevice } from '../VulkanDevice';
import {
  unwrap,
  VulkanCommandBuffer,
  VulkanCommandEncoder,
} from './VulkanCommandEncoder';
import { VulkanObjectTable } from './VulkanObjectTable';
import { VulkanPassTimer } from './VulkanPassTimer';
import { VulkanPipelineFactory } from './VulkanPipelineFactory';

// The conventions of WebGPU: depth in [0, 1], y up in clip space (the
// native library draws with a viewport of negative height), column-major
// matrices.
const cameraMath = new CameraMath(wgpuMatrixPrimitives);
const transformMath = new TransformMath(wgpuMatrixPrimitives);

/** The abstract rendering API on a Vulkan device. */
export class VulkanRenderBackend implements RenderBackend {
  readonly buffers;
  readonly textures: VulkanTextureFactory;
  readonly pipelines: VulkanPipelineFactory;
  readonly cameraMath = cameraMath;
  readonly transformMath = transformMath;
  // A 32-bit float depth, available on every GPU.
  readonly depthFormat = 'depth24plus';
  readonly capabilities: BackendCapabilities;

  constructor(readonly device: VulkanDevice) {
    this.buffers = device.buffers;
    this.textures = new VulkanTextureFactory(loadVulkanAddon(), device.context);
    this.capabilities = {
      renderableFormats: ['rgba16float'],
      // Those the device can sample (see VulkanTextureFactory).
      compressedFormats: this.textures.compressedFormats,
      // The object data in a table of storage buffers.
      objectTable: true,
      maxAnisotropy: loadVulkanAddon().maxAnisotropy(device.context),
      maxColorAttachments: loadVulkanAddon().maxColorAttachments(
        device.context,
      ),
      independentBlend: loadVulkanAddon().independentBlend(device.context),
      // Ray queries in every stage, where the GPU has them.
      rayQuery: loadVulkanAddon().rayQuerySupported(device.context),
      // And the ray tracing pipelines.
      rayTracingPipeline: loadVulkanAddon().rayTracingPipelineSupported(
        device.context,
      ),
    };
    this.pipelines = new VulkanPipelineFactory(
      loadVulkanAddon(),
      device.context,
    );
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
    return createBottomLevel(
      loadVulkanAddon(),
      this.device.context,
      descriptor,
    );
  }

  createTopLevel(descriptor?: TopLevelDescriptor): VulkanTopLevel {
    return createTopLevel(loadVulkanAddon(), this.device.context, descriptor);
  }

  // Where the queue writes timestamps.
  createPassTimer(capacity: number): GpuPassTimer | undefined {
    const addon = loadVulkanAddon();
    return addon.timestampsSupported(this.device.context)
      ? new VulkanPassTimer(addon, this.device.context, capacity)
      : undefined;
  }

  submit(commands: readonly GpuCommandBuffer[]): void {
    const addon = loadVulkanAddon();
    for (const command of commands) {
      addon.submit(
        this.device.context,
        unwrap(command, VulkanCommandBuffer, 'The command buffer').words,
      );
    }
  }
}
