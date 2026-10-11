import type {
  BackendCapabilities,
  GpuCommandBuffer,
  GpuCommandEncoder,
  GpuPassTimer,
  RenderBackend,
  RenderTargetDescriptor,
} from '@fdw/engine-backend';
import { BufferFactory } from '../gpu/BufferFactory';
import { TextureFactory } from '../gpu/TextureFactory';
import { cameraMath, transformMath } from '../math';
import {
  WebGpuCommandBuffer,
  WebGpuCommandEncoder,
} from './WebGpuCommandEncoder';
import { WebGpuPassTimer } from './WebGpuPassTimer';
import { WebGpuPipelineFactory } from './WebGpuPipelineFactory';
import { WebGpuRenderTarget } from './WebGpuRenderTarget';

export class WebGpuRenderBackend implements RenderBackend {
  readonly buffers: BufferFactory;
  readonly textures: TextureFactory;
  readonly pipelines: WebGpuPipelineFactory;
  readonly cameraMath = cameraMath;
  readonly transformMath = transformMath;
  readonly depthFormat = 'depth24plus';
  readonly capabilities: BackendCapabilities = {
    renderableFormats: ['rgba16float'],
  };

  constructor(readonly device: GPUDevice) {
    this.buffers = new BufferFactory(device);
    this.textures = new TextureFactory(device);
    this.pipelines = new WebGpuPipelineFactory(device);
  }

  createRenderTarget({
    width,
    height,
    format,
    label,
  }: RenderTargetDescriptor): WebGpuRenderTarget {
    const texture = this.device.createTexture({
      label,
      size: [width, height],
      format: format as GPUTextureFormat,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });
    return new WebGpuRenderTarget(
      texture.createView(),
      width,
      height,
      format,
      texture
    );
  }

  createCommandEncoder(): GpuCommandEncoder {
    return new WebGpuCommandEncoder(this.device.createCommandEncoder());
  }

  // Where the device has the timestamp-query feature (WebGpuEngine asks for
  // it when the adapter has it).
  createPassTimer(capacity: number): GpuPassTimer | undefined {
    return this.device.features.has('timestamp-query')
      ? new WebGpuPassTimer(this.device, capacity)
      : undefined;
  }

  submit(commands: readonly GpuCommandBuffer[]): void {
    const buffers = commands.map((command) => {
      if (!(command instanceof WebGpuCommandBuffer)) {
        throw new Error(
          'The command buffer was not created by the WebGPU backend'
        );
      }
      return command;
    });
    this.device.queue.submit(buffers.map((buffer) => buffer.commands));
    // The measures can be read back now.
    for (const buffer of buffers) {
      buffer.timers.forEach((timer) => timer.submitted());
    }
  }
}
