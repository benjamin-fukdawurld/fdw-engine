import { Engine, EngineState } from '@fdw/engine-backend';
import { signal, Signal } from '@preact/signals-core';
import { VulkanRenderBackend } from './render/VulkanRenderBackend';
import { VulkanDevice, VulkanDeviceOptions } from './VulkanDevice';
import type { ShaderCache } from './shader/ShaderCache';

export interface VulkanEngineOptions extends VulkanDeviceOptions {
  // The anisotropy of the samplers created without maxAnisotropy (see
  // GpuSamplerFactory.defaultMaxAnisotropy): 1 by default, 8 or 16 for
  // sharp textures on surfaces seen at a grazing angle.
  readonly maxAnisotropy?: number;
  // The programs compiled by DXC, kept between runs (FileShaderCache):
  // compiled once, not at each start. None by default.
  readonly shaderCache?: ShaderCache;
}

/**
 * The engine on Vulkan, through the native library of the package (Node
 * only). Its backend implements the abstract rendering API.
 */
export class VulkanEngine extends EventTarget implements Engine {
  device?: VulkanDevice;
  backend: VulkanRenderBackend | undefined = undefined;
  state: Signal<EngineState> = signal('uninitialized');

  constructor(private readonly _options: VulkanEngineOptions = {}) {
    super();
  }

  async init(): Promise<void> {
    if (
      this.state.value !== 'uninitialized' &&
      this.state.value !== 'destroyed'
    ) {
      throw new Error(
        `Cannot initialize an engine in the ${this.state.value} state`,
      );
    }
    this.state.value = 'initializing';
    try {
      this.device = new VulkanDevice(this._options);
      this.backend = new VulkanRenderBackend(this.device);
      this.backend.textures.defaultMaxAnisotropy =
        this._options.maxAnisotropy ?? 1;
      this.backend.pipelines.shaderCache = this._options.shaderCache;
    } catch (error) {
      this.device = undefined;
      this.state.value = 'uninitialized';
      throw error;
    }
    this.state.value = 'ready';
    this.dispatchEvent(new CustomEvent('ready', { detail: this }));
  }

  async pause(): Promise<void> {
    if (this.state.value !== 'ready') {
      throw new Error('Engine must be in ready state to pause');
    }
    this.state.value = 'paused';
    this.dispatchEvent(new CustomEvent('paused', { detail: this }));
  }

  async resume(): Promise<void> {
    if (this.state.value !== 'paused') {
      throw new Error('Engine must be in paused state to resume');
    }
    this.state.value = 'ready';
    this.dispatchEvent(new CustomEvent('resumed', { detail: this }));
  }

  async destroy(): Promise<void> {
    this.state.value = 'destroying';
    this.device?.destroy();
    this.device = undefined;
    this.backend = undefined;
    this.state.value = 'destroyed';
    this.dispatchEvent(new CustomEvent('destroyed', { detail: this }));
  }
}
