import { Engine, EngineState } from '@fdw/engine-backend';
import { signal, Signal } from '@preact/signals-core';
import { CompressionFeatures } from './gpu/TextureFactory';
import { WebGpuRenderBackend } from './render/WebGpuRenderBackend';

export type WebGpuEngineOptions = {
  // The WebGPU entry point. Defaults to navigator.gpu; can be provided to run
  // outside a browser (e.g. Dawn for Node).
  gpu?: GPU;
  // The anisotropy of the samplers created without maxAnisotropy (see
  // GpuSamplerFactory.defaultMaxAnisotropy): 1 by default, 8 or 16 for
  // sharp textures on surfaces seen at a grazing angle.
  maxAnisotropy?: number;
};

export class WebGpuEngine extends EventTarget implements Engine {
  adapter?: GPUAdapter;
  device?: GPUDevice;
  backend: WebGpuRenderBackend | undefined = undefined;
  state: Signal<EngineState> = signal('uninitialized');

  private readonly _gpu?: GPU;
  private readonly _maxAnisotropy: number;

  constructor(options: WebGpuEngineOptions = {}) {
    super();
    this._gpu = options.gpu;
    this._maxAnisotropy = options.maxAnisotropy ?? 1;
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
      const gpu = this._gpu ?? globalThis.navigator?.gpu;
      if (!gpu) {
        throw new Error('WebGPU is not supported in this environment');
      }

      const adapter = await gpu.requestAdapter();
      if (!adapter) {
        throw new Error('Failed to get GPU adapter');
      }
      this.adapter = adapter;
      // Timestamps, to measure the passes, and the compressed formats,
      // where the adapter has them.
      const features = ['timestamp-query', ...Object.keys(CompressionFeatures)];
      // The storage buffers of the adapter: the programs tracing rays bind
      // the buffers of the scene besides their own, and large BVHs.
      const { limits } = adapter;
      this.device = await adapter.requestDevice({
        requiredFeatures: features.filter((feature) =>
          adapter.features.has(feature),
        ) as GPUFeatureName[],
        requiredLimits: {
          maxStorageBuffersPerShaderStage:
            limits.maxStorageBuffersPerShaderStage,
          maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize,
          maxBufferSize: limits.maxBufferSize,
        },
      });
      this.backend = new WebGpuRenderBackend(this.device);
      this.backend.textures.defaultMaxAnisotropy = this._maxAnisotropy;
    } catch (error) {
      this.adapter = undefined;
      this.device = undefined;
      this.state.value = 'uninitialized';
      throw error;
    }

    this.state.value = 'ready';
    this.dispatchEvent(
      new CustomEvent<WebGpuEngine>('ready', { detail: this }),
    );
  }

  async pause(): Promise<void> {
    if (this.state.value !== 'ready') {
      throw new Error('Engine must be in ready state to pause');
    }

    this.state.value = 'paused';
    this.dispatchEvent(
      new CustomEvent<WebGpuEngine>('paused', { detail: this }),
    );
  }

  async resume(): Promise<void> {
    if (this.state.value !== 'paused') {
      throw new Error('Engine must be in paused state to resume');
    }

    this.state.value = 'ready';
    this.dispatchEvent(
      new CustomEvent<WebGpuEngine>('resumed', { detail: this }),
    );
  }

  async destroy(): Promise<void> {
    this.state.value = 'destroying';
    this.device?.destroy();
    this.device = undefined;
    this.adapter = undefined;
    this.backend = undefined;

    this.state.value = 'destroyed';
    this.dispatchEvent(
      new CustomEvent<WebGpuEngine>('destroyed', { detail: this }),
    );
  }
}

export default WebGpuEngine;
