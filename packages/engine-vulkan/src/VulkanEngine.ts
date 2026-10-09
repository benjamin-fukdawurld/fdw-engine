import { Engine, EngineState } from '@fdw/engine-backend';
import { signal, Signal } from '@preact/signals-core';
import { VulkanRenderBackend } from './render/VulkanRenderBackend';
import { VulkanDevice, VulkanDeviceOptions } from './VulkanDevice';

/**
 * The engine on Vulkan, through the native library of the package (Node
 * only). Its backend implements the abstract rendering API.
 */
export class VulkanEngine extends EventTarget implements Engine {
  device?: VulkanDevice;
  backend: VulkanRenderBackend | undefined = undefined;
  state: Signal<EngineState> = signal('uninitialized');

  constructor(private readonly _options: VulkanDeviceOptions = {}) {
    super();
  }

  async init(): Promise<void> {
    if (
      this.state.value !== 'uninitialized' &&
      this.state.value !== 'destroyed'
    ) {
      throw new Error(
        `Cannot initialize an engine in the ${this.state.value} state`
      );
    }
    this.state.value = 'initializing';
    try {
      this.device = new VulkanDevice(this._options);
      this.backend = new VulkanRenderBackend(this.device);
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
