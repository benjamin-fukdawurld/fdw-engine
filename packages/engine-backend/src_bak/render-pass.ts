/**
 * GPU Render Pass abstraction
 */

export interface ColorAttachment {
  /** The texture view to render into */
  view: unknown; // Backend-specific
  /** Clear color (RGBA 0-1), or undefined to load */
  clearValue?: { r: number; g: number; b: number; a: number };
  /** 'load' to keep existing, 'clear' to clear */
  loadOp: 'load' | 'clear';
  /** 'store' to keep, 'discard' to discard */
  storeOp: 'store' | 'discard';
}

export interface DepthStencilAttachment {
  view: unknown; // Backend-specific
  depthClearValue?: number;
  depthLoadOp: 'load' | 'clear';
  depthStoreOp: 'store' | 'discard';
}

export interface GpuRenderPassDescriptor {
  label?: string;
  colorAttachments: ColorAttachment[];
  depthStencilAttachment?: DepthStencilAttachment;
}

export interface GpuRenderPass {
  setPipeline(pipeline: import('./pipeline').GpuRenderPipeline): void;
  setVertexBuffer(
    slot: number,
    buffer: import('./buffer').GpuBuffer,
    offset?: number
  ): void;
  setIndexBuffer(
    buffer: import('./buffer').GpuBuffer,
    format: 'uint16' | 'uint32',
    offset?: number
  ): void;
  setBindGroup(
    index: number,
    bindGroup: import('./bind-group').GpuBindGroup,
    dynamicOffsets?: number[]
  ): void;
  draw(
    vertexCount: number,
    instanceCount?: number,
    firstVertex?: number,
    firstInstance?: number
  ): void;
  drawIndexed(
    indexCount: number,
    instanceCount?: number,
    firstIndex?: number,
    baseVertex?: number,
    firstInstance?: number
  ): void;
  end(): void;
}
