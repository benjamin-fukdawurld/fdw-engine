import type { GpuComputePass } from '@fdw/engine-backend';
import type { WebGpuComputePipeline } from './webgpu-compute-pipeline';
import type { WebGpuBindGroup } from './webgpu-bind-group';

/**
 * WebGPU implementation of {@link GpuComputePass}.
 *
 * Wraps a native `GPUComputePassEncoder` and delegates all dispatch commands to it.
 */
export class WebGpuComputePass implements GpuComputePass {
  private _native: GPUComputePassEncoder;

  constructor(native: GPUComputePassEncoder) {
    this._native = native;
  }

  setPipeline(pipeline: WebGpuComputePipeline): void {
    this._native.setPipeline(pipeline._native);
  }

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

  dispatchWorkgroups(x: number, y = 1, z = 1): void {
    this._native.dispatchWorkgroups(x, y, z);
  }

  end(): void {
    this._native.end();
  }
}
