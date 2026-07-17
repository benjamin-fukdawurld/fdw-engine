/**
 * GPU Bind Group abstraction (uniform/storage/texture bindings)
 */

import type { GpuBuffer } from './buffer';
import type { GpuSampler } from './texture';

export interface BindGroupLayoutEntry {
  binding: number;
  visibility: number; // Bitmask: vertex=1, fragment=2, compute=4
  type:
    | 'uniform-buffer'
    | 'storage-buffer'
    | 'read-only-storage-buffer'
    | 'sampler'
    | 'texture'
    | 'storage-texture';
}

export interface GpuBindGroupLayoutDescriptor {
  label?: string;
  entries: BindGroupLayoutEntry[];
}

export interface GpuBindGroupLayout {
  readonly label: string;
}

export interface BindGroupEntry {
  binding: number;
  resource:
    | { buffer: GpuBuffer; offset?: number; size?: number }
    | { sampler: GpuSampler }
    | { textureView: unknown }; // Backend-specific view
}

export interface GpuBindGroupDescriptor {
  label?: string;
  layout: GpuBindGroupLayout;
  entries: BindGroupEntry[];
}

export interface GpuBindGroup {
  readonly label: string;
}
