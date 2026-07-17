import type {
  GpuCommandEncoder,
  GpuCommandBuffer,
  GpuRenderPass,
  GpuRenderPassDescriptor,
  GpuComputePass,
} from '@fdw/engine-backend';
import { WebGpuRenderPass } from './webgpu-render-pass';
import { WebGpuComputePass } from './webgpu-compute-pass';

/**
 * WebGPU implementation of {@link GpuCommandEncoder}.
 *
 * Records GPU commands (render passes, copies) and produces a
 * {@link WebGpuCommandBuffer} for submission.
 */
export class WebGpuCommandEncoder implements GpuCommandEncoder {
  _native: GPUCommandEncoder;

  constructor(device: GPUDevice, label?: string) {
    this._native = device.createCommandEncoder({ label: label ?? '' });
  }

  /**
   * Begins a render pass with the given color and depth attachments.
   *
   * @param descriptor - Render pass configuration (attachments, clear values, load/store ops).
   * @returns A render pass encoder to record draw commands into.
   */
  beginRenderPass(descriptor: GpuRenderPassDescriptor): GpuRenderPass {
    const nativeDescriptor: GPURenderPassDescriptor = {
      label: descriptor.label,
      colorAttachments: descriptor.colorAttachments.map((ca) => ({
        view: ca.view as GPUTextureView,
        clearValue: ca.clearValue,
        loadOp: ca.loadOp,
        storeOp: ca.storeOp,
      })),
      depthStencilAttachment: descriptor.depthStencilAttachment
        ? {
            view: descriptor.depthStencilAttachment.view as GPUTextureView,
            depthClearValue:
              descriptor.depthStencilAttachment.depthClearValue ?? 1.0,
            depthLoadOp: descriptor.depthStencilAttachment.depthLoadOp,
            depthStoreOp: descriptor.depthStencilAttachment.depthStoreOp,
          }
        : undefined,
    };

    const nativePass = this._native.beginRenderPass(nativeDescriptor);
    return new WebGpuRenderPass(nativePass);
  }

  beginComputePass(label?: string): GpuComputePass {
    const nativePass = this._native.beginComputePass({ label: label ?? '' });
    return new WebGpuComputePass(nativePass);
  }

  /** Finishes recording and returns a command buffer ready for submission. */
  finish(): WebGpuCommandBuffer {
    return new WebGpuCommandBuffer(this._native.finish());
  }
}

/** Holds a finalized GPU command buffer ready to be submitted via {@link WebGpuBackend.submit}. */
export class WebGpuCommandBuffer implements GpuCommandBuffer {
  readonly label = '';
  _native: GPUCommandBuffer;

  constructor(native: GPUCommandBuffer) {
    this._native = native;
  }
}
