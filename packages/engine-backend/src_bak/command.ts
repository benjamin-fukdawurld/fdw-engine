/**
 * GPU Command Encoder & Command Buffer abstraction
 */

import type { GpuRenderPass, GpuRenderPassDescriptor } from './render-pass';
import type { GpuComputePass } from './GpuComputePass';

export interface GpuCommandEncoder {
  beginRenderPass(descriptor: GpuRenderPassDescriptor): GpuRenderPass;
  beginComputePass(label?: string): GpuComputePass;
  finish(): GpuCommandBuffer;
}

export interface GpuCommandBuffer {
  readonly label: string;
}
