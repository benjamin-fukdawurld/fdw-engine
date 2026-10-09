import type {
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
        view: unwrap(attachment.target, WebGpuRenderTarget, 'The color target')
          .view,
        loadOp: attachment.load,
        storeOp: 'store',
        clearValue: attachment.clearValue ?? { r: 0, g: 0, b: 0, a: 1 },
      })),
      ...(depth
        ? {
            depthStencilAttachment: {
              view: unwrap(depth.target, WebGpuRenderTarget, 'The depth target')
                .view,
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

  finish(): GpuCommandBuffer {
    return new WebGpuCommandBuffer(this._encoder.finish());
  }
}
