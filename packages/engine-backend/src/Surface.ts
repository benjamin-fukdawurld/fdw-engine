import type { Engine } from './Engine';
import type { GpuTextureFormat } from './gpu';
import type { GpuRenderTarget } from './render';

// Where a frame is rendered: a window or canvas, or an offscreen image.
export interface Surface {
  width: number;
  height: number;
  // Format of the images of the surface, known once initialized.
  readonly format: GpuTextureFormat;
  init(engine: Engine): Promise<void>;
  // The image to render the current frame to.
  getCurrentTarget(): GpuRenderTarget;
  // Presents the current frame. A no-op on backends that present implicitly
  // (WebGPU), needed for swapchains (Vulkan).
  present(): void;
}
