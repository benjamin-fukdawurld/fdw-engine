import type {
  GpuAttachmentTarget,
  GpuBindGroup,
  GpuComputePassEncoder,
  GpuComputePipeline,
  GpuBuffer,
  GpuCommandBuffer,
  GpuCommandEncoder,
  GpuRenderPassEncoder,
  GpuRenderPipeline,
  IndexFormat,
  RenderPassDescriptor,
} from '@fdw/engine-backend';
import { Buffer } from '../gpu/BufferFactory';
import { Texture } from '../gpu/Texture';
import {
  WebGpuBindGroup,
  WebGpuComputePipeline,
  WebGpuRenderPipeline,
} from './WebGpuPipelineFactory';
import { WebGpuRenderTarget } from './WebGpuRenderTarget';

function unwrap<T>(
  value: unknown,
  type: abstract new (...args: never[]) => T,
  what: string
): T {
  if (!(value instanceof type)) {
    throw new Error(`${what} was not created by the WebGPU backend`);
  }
  return value;
}

// The view rendered to, for a render target or a texture.
function attachmentView(target: unknown, what: string): GPUTextureView {
  if (target instanceof WebGpuRenderTarget) {
    return target.view;
  }
  const texture = unwrap(target, Texture, what);
  if (!texture.view) {
    throw new Error(`${what} was destroyed`);
  }
  return texture.view;
}

// The texture behind a render target or a texture, for copies.
function gpuTexture(target: unknown, what: string): GPUTexture {
  const texture =
    target instanceof WebGpuRenderTarget
      ? target.texture
      : unwrap(target, Texture, what).texture;
  if (!texture) {
    throw new Error(`${what} has no texture to copy (a canvas image?)`);
  }
  return texture;
}

class WebGpuRenderPassEncoder implements GpuRenderPassEncoder {
  constructor(private readonly _pass: GPURenderPassEncoder) {}

  setPipeline(pipeline: GpuRenderPipeline): void {
    this._pass.setPipeline(
      unwrap(pipeline, WebGpuRenderPipeline, 'The pipeline').pipeline
    );
  }

  setBindGroup(index: number, group: GpuBindGroup): void {
    this._pass.setBindGroup(
      index,
      unwrap(group, WebGpuBindGroup, 'The bind group').group
    );
  }

  setVertexBuffer(slot: number, buffer: GpuBuffer): void {
    this._pass.setVertexBuffer(
      slot,
      unwrap(buffer, Buffer, 'The vertex buffer').buffer
    );
  }

  setIndexBuffer(buffer: GpuBuffer, format: IndexFormat): void {
    this._pass.setIndexBuffer(
      unwrap(buffer, Buffer, 'The index buffer').buffer,
      format
    );
  }

  draw(vertexCount: number, instanceCount = 1): void {
    this._pass.draw(vertexCount, instanceCount);
  }

  drawIndexed(indexCount: number, instanceCount = 1): void {
    this._pass.drawIndexed(indexCount, instanceCount);
  }

  end(): void {
    this._pass.end();
  }
}

class WebGpuComputePassEncoder implements GpuComputePassEncoder {
  constructor(private readonly _pass: GPUComputePassEncoder) {}

  setPipeline(pipeline: GpuComputePipeline): void {
    this._pass.setPipeline(
      unwrap(pipeline, WebGpuComputePipeline, 'The pipeline').pipeline
    );
  }

  setBindGroup(index: number, group: GpuBindGroup): void {
    this._pass.setBindGroup(
      index,
      unwrap(group, WebGpuBindGroup, 'The bind group').group
    );
  }

  dispatchWorkgroups(x: number, y = 1, z = 1): void {
    this._pass.dispatchWorkgroups(x, y, z);
  }

  dispatchWorkgroupsIndirect(buffer: GpuBuffer, offset: number): void {
    this._pass.dispatchWorkgroupsIndirect(
      unwrap(buffer, Buffer, 'The indirect buffer').buffer,
      offset
    );
  }

  end(): void {
    this._pass.end();
  }
}

export class WebGpuCommandBuffer {
  constructor(readonly commands: GPUCommandBuffer) {}
}

export class WebGpuCommandEncoder implements GpuCommandEncoder {
  constructor(private readonly _encoder: GPUCommandEncoder) {}

  beginRenderPass(descriptor: RenderPassDescriptor): GpuRenderPassEncoder {
    const depth = descriptor.depthAttachment;
    const pass = this._encoder.beginRenderPass({
      label: descriptor.label,
      colorAttachments: descriptor.colorAttachments.map((attachment) => ({
        view: attachmentView(attachment.target, 'The color target'),
        loadOp: attachment.load,
        storeOp: 'store',
        clearValue: attachment.clearValue ?? { r: 0, g: 0, b: 0, a: 1 },
      })),
      ...(depth
        ? {
            depthStencilAttachment: {
              view: attachmentView(depth.target, 'The depth target'),
              depthLoadOp: depth.load,
              depthStoreOp: 'store',
              depthClearValue: depth.clearValue ?? 1,
              // Stencil formats need the stencil operations too.
              ...(depth.target.format.includes('stencil')
                ? {
                    stencilLoadOp: 'clear',
                    stencilStoreOp: 'store',
                    stencilClearValue: 0,
                  }
                : {}),
            },
          }
        : {}),
    });
    return new WebGpuRenderPassEncoder(pass);
  }

  beginComputePass(label?: string): GpuComputePassEncoder {
    return new WebGpuComputePassEncoder(
      this._encoder.beginComputePass(label ? { label } : {})
    );
  }

  copyBufferToBuffer(
    source: GpuBuffer,
    sourceOffset: number,
    destination: GpuBuffer,
    destinationOffset: number,
    size: number
  ): void {
    this._encoder.copyBufferToBuffer(
      unwrap(source, Buffer, 'The source buffer').buffer,
      sourceOffset,
      unwrap(destination, Buffer, 'The destination buffer').buffer,
      destinationOffset,
      size
    );
  }

  copyTextureToTexture(
    source: GpuAttachmentTarget,
    destination: GpuAttachmentTarget,
    size: { readonly width: number; readonly height: number }
  ): void {
    this._encoder.copyTextureToTexture(
      { texture: gpuTexture(source, 'The source texture') },
      { texture: gpuTexture(destination, 'The destination texture') },
      [size.width, size.height]
    );
  }

  finish(): GpuCommandBuffer {
    return new WebGpuCommandBuffer(this._encoder.finish());
  }
}
