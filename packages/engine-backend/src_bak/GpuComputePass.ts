/**
 * GPU Compute Pass abstraction
 */

import type { GpuComputePipeline } from './compute-pipeline';
import type { GpuBindGroup } from './bind-group';

export interface GpuComputePass {
  setPipeline(pipeline: GpuComputePipeline): void;
  setBindGroup(
    index: number,
    bindGroup: GpuBindGroup,
    dynamicOffsets?: number[],
  ): void;
  dispatchWorkgroups(x: number, y?: number, z?: number): void;
  end(): void;
}
