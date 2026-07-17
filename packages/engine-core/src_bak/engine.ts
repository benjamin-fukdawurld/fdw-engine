import type { GpuBackend } from '@fdw/engine-backend';

export type EngineParams = {
  backend: GpuBackend;
};

export class Engine {
  private _backend: GpuBackend;

  constructor(options: EngineParams) {
    this._backend = options.backend;
  }

  /** Initialize the backend and start rendering */
  async init(): Promise<void> {
    await this._backend.init();
  }

  /** Destroy the viewer and release all GPU resources */
  destroy(): void {
    this._backend.destroy();
  }
}
