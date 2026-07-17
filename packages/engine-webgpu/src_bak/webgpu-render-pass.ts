import type { GpuRenderPass } from '@fdw/engine-backend';
import type { WebGpuRenderPipeline } from './webgpu-pipeline';
import type { WebGpuBuffer } from './webgpu-buffer';
import type { WebGpuBindGroup } from './webgpu-bind-group';

/**
 * WebGPU implementation of {@link GpuRenderPass}.
 *
 * Wraps a native `GPURenderPassEncoder` and delegates all draw commands to it.
 */
export class WebGpuRenderPass implements GpuRenderPass {
  private _native: GPURenderPassEncoder;

  constructor(native: GPURenderPassEncoder) {
    this._native = native;
  }

  /** Binds a render pipeline for subsequent draw calls. */
  setPipeline(pipeline: WebGpuRenderPipeline): void {
    this._native.setPipeline(pipeline._native);
  }

  /**
   * Binds a vertex buffer to a slot.
   *
   * @param slot - Vertex buffer slot index.
   * @param buffer - The buffer to bind.
   * @param offset - Byte offset into the buffer.
   */
  setVertexBuffer(slot: number, buffer: WebGpuBuffer, offset = 0): void {
    this._native.setVertexBuffer(slot, buffer._native, offset);
  }

  /**
   * Binds an index buffer.
   *
   * @param buffer - The index buffer to bind.
   * @param format - Index element format (`'uint16'` or `'uint32'`).
   * @param offset - Byte offset into the buffer.
   */
  setIndexBuffer(
    buffer: WebGpuBuffer,
    format: 'uint16' | 'uint32',
    offset = 0,
  ): void {
    this._native.setIndexBuffer(buffer._native, format, offset);
  }

  /**
   * Binds a bind group at the given index.
   *
   * @param index - Bind group index matching the pipeline layout.
   * @param bindGroup - The bind group to set.
   * @param dynamicOffsets - Optional dynamic offsets for dynamic buffer bindings.
   */
  setBindGroup(
    index: number,
    bindGroup: WebGpuBindGroup,
    dynamicOffsets?: number[],
  ): void {
    if (dynamicOffsets) {
      this._native.setBindGroup(index, bindGroup._native, dynamicOffsets);
    } else {
      this._native.setBindGroup(index, bindGroup._native);
    }
  }

  /**
   * Issues a non-indexed draw call.
   *
   * @param vertexCount - Number of vertices to draw.
   * @param instanceCount - Number of instances.
   * @param firstVertex - Offset of the first vertex.
   * @param firstInstance - Offset of the first instance.
   */
  draw(
    vertexCount: number,
    instanceCount = 1,
    firstVertex = 0,
    firstInstance = 0,
  ): void {
    this._native.draw(vertexCount, instanceCount, firstVertex, firstInstance);
  }

  /**
   * Issues an indexed draw call.
   *
   * @param indexCount - Number of indices to draw.
   * @param instanceCount - Number of instances.
   * @param firstIndex - Offset into the index buffer.
   * @param baseVertex - Value added to each index before vertex lookup.
   * @param firstInstance - Offset of the first instance.
   */
  drawIndexed(
    indexCount: number,
    instanceCount = 1,
    firstIndex = 0,
    baseVertex = 0,
    firstInstance = 0,
  ): void {
    this._native.drawIndexed(
      indexCount,
      instanceCount,
      firstIndex,
      baseVertex,
      firstInstance,
    );
  }

  /** Ends the render pass and finalizes recorded commands. */
  end(): void {
    this._native.end();
  }
}
