import type { Engine, GpuTextureFormat, Surface } from '@fdw/engine-backend';
import {
  VulkanEngine,
  VulkanSwapchain,
  VulkanTexture,
} from '@fdw/engine-vulkan';
import type { NativeWindow } from './NativeWindow';

export interface VulkanWindowSurfaceOptions {
  // Waits for the vertical synchronization. Default true.
  readonly vsync?: boolean;
}

/**
 * A surface presenting Vulkan frames into a native window, without copy: a
 * swapchain on the window, recreated when its size changes. The window
 * must be created with `vulkan: true`. acquire waits while two frames are
 * in flight, and the presentation follows the vertical synchronization:
 * the render loop needs no throttle.
 */
export class VulkanWindowSurface implements Surface {
  private _swapchain?: VulkanSwapchain;
  private _current?: VulkanTexture;

  constructor(
    readonly window: NativeWindow,
    private readonly _options: VulkanWindowSurfaceOptions = {}
  ) {}

  async init(engine: Engine): Promise<void> {
    if (!(engine instanceof VulkanEngine) || !engine.device) {
      throw new Error('The surface needs a ready VulkanEngine');
    }
    this._swapchain = new VulkanSwapchain(
      engine.device,
      this.window.nativeHandle,
      this.window.width,
      this.window.height,
      this._options
    );
  }

  // The format of the images: bgra8unorm or rgba8unorm, written as is (the
  // engine encodes the colors).
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
      this.window.height
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

  private get swapchain(): VulkanSwapchain {
    if (!this._swapchain) {
      throw new Error('The surface is not initialized');
    }
    return this._swapchain;
  }
}
