import type { Engine, GpuTextureFormat, Surface } from '@fdw/engine-backend';
import {
  VulkanEngine,
  VulkanSwapchain,
  VulkanTexture,
} from '@fdw/engine-vulkan';
import type { X11Viewport } from './viewport';

/**
 * A surface presenting Vulkan frames into the viewport, without copy: a
 * swapchain on its window, recreated when its bounds change size (as
 * VulkanWindowSurface of @fdw/engine-native does for a NativeWindow).
 * FIFO: the swapchain sets the pace of the render loop.
 */
export class ViewportSurface implements Surface {
  private _swapchain?: VulkanSwapchain;
  private _current?: VulkanTexture;

  constructor(readonly viewport: X11Viewport) {}

  async init(engine: Engine): Promise<void> {
    if (!(engine instanceof VulkanEngine) || !engine.device) {
      throw new Error('The surface needs a ready VulkanEngine');
    }
    this._swapchain = new VulkanSwapchain(
      engine.device,
      this.viewport.window,
      this.width,
      this.height,
    );
  }

  get format(): GpuTextureFormat {
    return this.swapchain.format;
  }

  get width(): number {
    return this.viewport.width;
  }

  get height(): number {
    return this.viewport.height;
  }

  getCurrentTarget(): VulkanTexture {
    this._current ??= this.swapchain.acquire(this.width, this.height);
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
