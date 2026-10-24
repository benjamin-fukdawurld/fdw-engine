import type { Engine, GpuTextureFormat, Surface } from '@fdw/engine-backend';
import { D3D12Engine, D3D12Swapchain } from '@fdw/engine-d3d12';
import type { VulkanTexture } from '@fdw/engine-vulkan';
import type { NativeWindow } from './NativeWindow';

export interface D3D12WindowSurfaceOptions {
  // Waits for the vertical synchronization. Default true.
  readonly vsync?: boolean;
}

/**
 * A surface presenting Direct3D 12 frames into a native window (Windows),
 * without copy: a DXGI swapchain on the window, resized with it. acquire
 * waits while two frames are in flight, and the presentation follows the
 * vertical synchronization: the render loop needs no throttle.
 */
export class D3D12WindowSurface implements Surface {
  private _swapchain?: D3D12Swapchain;
  private _current?: VulkanTexture;

  constructor(
    readonly window: NativeWindow,
    private readonly _options: D3D12WindowSurfaceOptions = {},
  ) {}

  async init(engine: Engine): Promise<void> {
    if (!(engine instanceof D3D12Engine) || !engine.device) {
      throw new Error('The surface needs a ready D3D12Engine');
    }
    this._swapchain = new D3D12Swapchain(
      engine.device,
      this.window.nativeHandle,
      this.window.width,
      this.window.height,
      this._options,
    );
  }

  // The format of the images: bgra8unorm, written as is (the engine
  // encodes the colors).
  get format(): GpuTextureFormat {
    return this.swapchain.format;
  }

  // The size of the window, in pixels.
  get width(): number {
    return this.window.width;
  }

  get height(): number {
    return this.window.height;
  }

  getCurrentTarget(): VulkanTexture {
    this._current ??= this.swapchain.acquire(
      this.window.width,
      this.window.height,
    );
    return this._current;
  }

  present(): void {
    if (this._current) {
      this.swapchain.present();
      this._current = undefined;
    }
  }

  destroy(): void {
    this._swapchain?.destroy();
    this._swapchain = undefined;
    this._current = undefined;
  }

  private get swapchain(): D3D12Swapchain {
    if (!this._swapchain) {
      throw new Error('The surface is not initialized');
    }
    return this._swapchain;
  }
}
