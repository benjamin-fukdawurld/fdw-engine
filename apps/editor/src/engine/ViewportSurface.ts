import type { Engine, GpuTextureFormat, Surface } from '@fdw/engine-backend';
import { D3D12Engine, D3D12Swapchain } from '@fdw/engine-d3d12';
import {
  VulkanEngine,
  VulkanSwapchain,
  VulkanTexture,
} from '@fdw/engine-vulkan';
import type { NativeViewport } from './viewport';

/**
 * A surface presenting Vulkan or Direct3D 12 frames into the viewport,
 * without copy: a swapchain on its window, recreated when its bounds change
 * size (as VulkanWindowSurface of @fdw/engine-native does for a
 * NativeWindow). FIFO: the swapchain sets the pace of the render loop.
 */
export class ViewportSurface implements Surface {
  private _swapchain?: VulkanSwapchain | D3D12Swapchain;
  private _current?: VulkanTexture;

  constructor(readonly viewport: NativeViewport) {}

  async init(engine: Engine): Promise<void> {
    const { window } = this.viewport;
    if (engine instanceof VulkanEngine && engine.device) {
      this._swapchain = new VulkanSwapchain(
        engine.device,
        window,
        this.width,
        this.height,
      );
    } else if (engine instanceof D3D12Engine && engine.device) {
      this._swapchain = new D3D12Swapchain(
        engine.device,
        window,
        this.width,
        this.height,
      );
    } else {
      throw new Error('The surface needs a ready VulkanEngine or D3D12Engine');
    }
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

  private get swapchain(): VulkanSwapchain | D3D12Swapchain {
    if (!this._swapchain) {
      throw new Error('The surface is not initialized');
    }
    return this._swapchain;
  }
}
