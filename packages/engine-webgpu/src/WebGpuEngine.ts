import { Engine, EngineState } from '@fdw/engine-backend';
import { signal, Signal } from '@preact/signals-core';

export class WebGpuEngine extends EventTarget implements Engine {
  adapter?: GPUAdapter;
  device?: GPUDevice;
  state: Signal<EngineState> = signal('uninitialized');

  async init(): Promise<void> {
    this.state.value = 'initializing';
    if (!navigator.gpu) {
      throw new Error('WebGPU is not supported in this browser');
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error('Failed to get GPU adapter');
    }
    this.adapter = adapter;

    const device = await this.adapter.requestDevice();
    if (!device) {
      throw new Error('Failed to get GPU device');
    }
    this.device = device;
    this.state.value = 'ready';
    this.dispatchEvent(
      new CustomEvent<WebGpuEngine>('ready', { detail: this })
    );
  }

  async pause(): Promise<void> {
    if (this.state.value !== 'ready') {
      throw new Error('Engine must be in ready state to pause');
    }

    this.state.value = 'paused';
    this.dispatchEvent(
      new CustomEvent<WebGpuEngine>('paused', { detail: this })
    );
  }

  async resume(): Promise<void> {
    if (this.state.value !== 'paused') {
      throw new Error('Engine must be in paused state to resume');
    }

    this.state.value = 'ready';
    this.dispatchEvent(
      new CustomEvent<WebGpuEngine>('resumed', { detail: this })
    );
  }

  async destroy(): Promise<void> {
    this.state.value = 'destroying';
    this.device!.destroy();
    this.device = undefined;
    this.adapter = undefined;

    this.state.value = 'destroyed';
    this.dispatchEvent(
      new CustomEvent<WebGpuEngine>('destroyed', { detail: this })
    );
  }
}

export default WebGpuEngine;
