import type {
  GpuBindGroup,
  GpuBindGroupDescriptor,
  GpuBindGroupLayout,
  GpuBindGroupLayoutDescriptor,
  BindGroupLayoutEntry,
} from '@fdw/engine-backend';
import type { WebGpuBuffer } from './webgpu-buffer';
import type { WebGpuSampler } from './webgpu-sampler';

/**
 * WebGPU implementation of {@link GpuBindGroupLayout}.
 *
 * Describes the shape of a bind group — the binding indices, visibility,
 * and resource types (uniform buffers, samplers, textures, etc.).
 */
export class WebGpuBindGroupLayout implements GpuBindGroupLayout {
  readonly label: string;
  _native: GPUBindGroupLayout;

  constructor(device: GPUDevice, descriptor: GpuBindGroupLayoutDescriptor) {
    this.label = descriptor.label ?? '';
    this._native = device.createBindGroupLayout({
      label: this.label,
      entries: descriptor.entries.map((e) => mapLayoutEntry(e)),
    });
  }
}

function mapLayoutEntry(entry: BindGroupLayoutEntry): GPUBindGroupLayoutEntry {
  const base: GPUBindGroupLayoutEntry = {
    binding: entry.binding,
    visibility: entry.visibility,
  };

  switch (entry.type) {
    case 'uniform-buffer':
      base.buffer = { type: 'uniform' };
      break;
    case 'storage-buffer':
      base.buffer = { type: 'storage' };
      break;
    case 'read-only-storage-buffer':
      base.buffer = { type: 'read-only-storage' };
      break;
    case 'sampler':
      base.sampler = { type: 'filtering' };
      break;
    case 'texture':
      base.texture = { sampleType: 'float' };
      break;
    case 'storage-texture':
      base.storageTexture = { access: 'write-only', format: 'rgba8unorm' };
      break;
  }

  return base;
}

/**
 * WebGPU implementation of {@link GpuBindGroup}.
 *
 * Binds concrete GPU resources (buffers, samplers, texture views)
 * to a {@link WebGpuBindGroupLayout}.
 */
export class WebGpuBindGroup implements GpuBindGroup {
  readonly label: string;
  _native: GPUBindGroup;

  constructor(device: GPUDevice, descriptor: GpuBindGroupDescriptor) {
    this.label = descriptor.label ?? '';
    const layout = (descriptor.layout as WebGpuBindGroupLayout)._native;

    this._native = device.createBindGroup({
      label: this.label,
      layout,
      entries: descriptor.entries.map((e) => {
        const resource = e.resource;
        if ('buffer' in resource) {
          return {
            binding: e.binding,
            resource: {
              buffer: (resource.buffer as WebGpuBuffer)._native,
              offset: resource.offset ?? 0,
              size: resource.size ?? (resource.buffer as WebGpuBuffer).size,
            },
          };
        } else if ('sampler' in resource) {
          return {
            binding: e.binding,
            resource: (resource.sampler as WebGpuSampler)._native,
          };
        } else {
          // textureView — already a GPUTextureView
          return {
            binding: e.binding,
            resource: resource.textureView as GPUTextureView,
          };
        }
      }),
    });
  }
}
