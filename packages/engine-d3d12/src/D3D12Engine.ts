import { Engine, EngineState } from '@fdw/engine-backend';
import { signal, Signal } from '@preact/signals-core';
import { D3D12RenderBackend } from './render/D3D12RenderBackend';
import { D3D12Device, D3D12DeviceOptions } from './D3D12Device';

export interface D3D12EngineOptions extends D3D12DeviceOptions {
  // The anisotropy of the samplers created without maxAnisotropy (see
  // GpuSamplerFactory.defaultMaxAnisotropy): 1 by default, 8 or 16 for
  // sharp textures on surfaces seen at a grazing angle.
  readonly maxAnisotropy?: number;
}

/**
 * The engine on Direct3D 12, through the native library of the package
 * (Node on Windows only). Its backend implements the abstract rendering
 * API.
 */
export class D3D12Engine extends EventTarget implements Engine {
  device?: D3D12Device;
  backend: D3D12RenderBackend | undefined = undefined;
  state: Signal<EngineState> = signal('uninitialized');

  constructor(private readonly _options: D3D12EngineOptions = {}) {
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
      this.device = new D3D12Device(this._options);
      this.backend = new D3D12RenderBackend(this.device);
      this.backend.textures.defaultMaxAnisotropy =
        this._options.maxAnisotropy ?? 1;
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
