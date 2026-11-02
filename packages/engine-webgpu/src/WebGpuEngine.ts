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

/** The detail of the `lost` event: why the device was lost. */
export type WebGpuDeviceLost = {
  readonly engine: WebGpuEngine;
  readonly reason: GPUDeviceLostReason;
  readonly message: string;
};

/**
 * The engine of WebGPU. Besides the events of the states, dispatches `lost`
 * when the device is lost other than by destroy() (the engine must then be
 * destroyed and initialized again), and `error` for the errors no error
 * scope caught (the validation errors of the commands, out of memory),
 * logged unless a listener calls preventDefault().
 */
export class WebGpuEngine extends EventTarget implements Engine {
  adapter?: GPUAdapter;
  device?: GPUDevice;
  backend: WebGpuRenderBackend | undefined = undefined;
  state: Signal<EngineState> = signal('uninitialized');
  // Whether the device was lost: nothing it renders is shown any longer.
  lost = false;

  private readonly _gpu?: GPU;
  private readonly _maxAnisotropy: number;
  // Incremented by each init() and destroy(): an initialization overtaken
  // by another call drops its device.
  private _generation = 0;

  constructor(options: WebGpuEngineOptions = {}) {
    super();
    this._gpu = options.gpu;
    this._maxAnisotropy = options.maxAnisotropy ?? 1;
  }

  /** The WebGPU entry point: the one of the options, or navigator.gpu. */
  get gpu(): GPU | undefined {
    return this._gpu ?? globalThis.navigator?.gpu;
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
    this.lost = false;
    const generation = ++this._generation;

    let device: GPUDevice | undefined;
    try {
      const gpu = this.gpu;
      if (!gpu) {
        throw new Error('WebGPU is not supported in this environment');
      }

      const adapter = await gpu.requestAdapter();
      if (!adapter) {
        throw new Error('Failed to get GPU adapter');
      }
      // Timestamps, to measure the passes, and the compressed formats,
      // where the adapter has them.
      const features = ['timestamp-query', ...Object.keys(CompressionFeatures)];
      // The storage buffers of the adapter: the programs tracing rays bind
      // the buffers of the scene besides their own, and large BVHs.
      const { limits } = adapter;
      device = await adapter.requestDevice({
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
      // Destroyed while waiting for the adapter or the device: the device
      // is not kept (destroy() already left the engine destroyed).
      if (generation !== this._generation) {
        device.destroy();
        throw new Error('The engine was destroyed during its initialization');
      }
      this.adapter = adapter;
      this.device = device;
      this.watch(device);
      this.backend = new WebGpuRenderBackend(device);
      this.backend.textures.defaultMaxAnisotropy = this._maxAnisotropy;
    } catch (error) {
      if (generation === this._generation) {
        device?.destroy();
        this.adapter = undefined;
        this.device = undefined;
        this.backend = undefined;
        this.state.value = 'uninitialized';
      }
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
    this._generation++;
    this.state.value = 'destroying';
    // Cleared first: the loss of a destroyed device is not reported.
    const device = this.device;
    this.device = undefined;
    device?.destroy();
    this.adapter = undefined;
    this.backend = undefined;

    this.state.value = 'destroyed';
    this.dispatchEvent(
      new CustomEvent<WebGpuEngine>('destroyed', { detail: this }),
    );
  }

  // Reports the loss of the device, and the errors no scope caught.
  private watch(device: GPUDevice): void {
    device.lost.then((info) => {
      // Lost by destroy(), or replaced by another initialization.
      if (this.device !== device) {
        return;
      }
      this.lost = true;
      this.dispatchEvent(
        new CustomEvent<WebGpuDeviceLost>('lost', {
          detail: { engine: this, reason: info.reason, message: info.message },
        }),
      );
    });
    // Optional: some implementations (Dawn for Node) have no events.
    device.addEventListener?.('uncapturederror', (event) => {
      if (this.device !== device) {
        return;
      }
      const { error } = event as GPUUncapturedErrorEvent;
      // Logged when nobody listens, rather than lost.
      if (
        this.dispatchEvent(
          new CustomEvent<GPUError>('error', {
            detail: error,
            cancelable: true,
          }),
        )
      ) {
        console.error(`WebGPU: ${error.message}`);
      }
    });
  }
}

export default WebGpuEngine;
