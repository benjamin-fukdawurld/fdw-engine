/**
 * GPU Compute Pipeline abstraction
 */

import type { GpuBindGroupLayout } from './bind-group';
import type { GpuShaderModule } from './shader';

export interface GpuComputePipelineDescriptor {
  label?: string;
  compute: {
    module: GpuShaderModule;
    entryPoint: string;
  };
  layout?: GpuBindGroupLayout[];
}

export interface GpuComputePipeline {
  readonly label: string;
}
