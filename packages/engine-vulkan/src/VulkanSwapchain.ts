import type { GpuTextureFormat } from '@fdw/engine-backend';
import {
  loadVulkanAddon,
  NativeWindowHandle,
  SwapchainHandle,
  VulkanAddon,
} from './addon';
import { VulkanTexture } from './gpu/VulkanTexture';
import type { VulkanDevice } from './VulkanDevice';

export interface VulkanSwapchainOptions {
  // Waits for the vertical synchronization (FIFO). Default true; without it,
  // mailbox or immediate presentation.
  readonly vsync?: boolean;
}

/**
 * The images presented into a native window. acquire() gives the image of
 * the frame (a render target of the commands), present() shows it. At most
 * two frames are in flight: acquire() waits for the one before the last.
 */
export class VulkanSwapchain {
  readonly format: GpuTextureFormat;
  private readonly _addon: VulkanAddon;
  private _handle?: SwapchainHandle;
  private _images: VulkanTexture[] = [];
  private _width = 0;
  private _height = 0;

  constructor(
    private readonly _device: VulkanDevice,
    window: NativeWindowHandle,
    width: number,
    height: number,
    { vsync = true }: VulkanSwapchainOptions = {}
  ) {
    this._addon = loadVulkanAddon();
    this._handle = this._addon.createSwapchain(
      _device.context,
      window,
      width,
      height,
      vsync
    );
    this.format = this._addon.swapchainFormat(this._handle);
  }

  /**
   * The image to render the frame into, at the size of the window (the
   * swapchain is recreated when it changes). The same until present().
   */
  acquire(width: number, height: number): VulkanTexture {
    const handle = this.handle;
    const acquired = this._addon.acquireImage(handle, width, height);
    if (
      acquired.recreated ||
      this._images.length === 0 ||
      acquired.width !== this._width ||
      acquired.height !== this._height
    ) {
      this._width = acquired.width;
      this._height = acquired.height;
      this._images = this._addon
        .swapchainImages(handle)
        .map(
          (image, index) =>
            new VulkanTexture(
              this._addon,
              this._device.context,
              '2d',
              this.format,
              { width: acquired.width, height: acquired.height },
              ['render-attachment', 'copy-src', 'copy-dst'],
              1,
              `swapchain image ${index}`,
              image
            )
        );
    }
    return this._images[acquired.index];
  }

  /** Shows the acquired image, after the commands submitted so far. */
  present(): void {
    this._addon.present(this.handle);
  }

  destroy(): void {
    if (this._handle) {
      this._addon.destroySwapchain(this._handle);
      this._handle = undefined;
      this._images = [];
    }
  }

  private get handle(): SwapchainHandle {
    if (!this._handle) {
      throw new Error('The swapchain was destroyed');
    }
    return this._handle;
  }
}
