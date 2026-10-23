import type { RgbaWindow } from '@fdw/engine-native';
import type { NativeWindowHandle } from '@fdw/engine-vulkan';
import type { ViewportBounds } from '@fdw/editor-ui/protocol';

// The addon of native/ (built by scripts/build-native.mjs).
interface ViewportAddon {
  createViewport(parent: bigint): unknown;
  viewportWindow(viewport: unknown): NativeWindowHandle;
  setViewportBounds(
    viewport: unknown,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void;
  pumpViewport(viewport: unknown): void;
  presentViewport(
    viewport: unknown,
    pixels: Uint8Array,
    width: number,
    height: number,
    stride: number,
  ): void;
  destroyViewport(viewport: unknown): void;
}

let addon: ViewportAddon | undefined;

// process.dlopen rather than require: the bundler leaves it alone. Its path
// comes from the main process.
function loadAddon(): ViewportAddon {
  if (!addon) {
    const path = process.env['FDW_EDITOR_ADDON'];
    if (!path) throw new Error('FDW_EDITOR_ADDON is not set');
    const module = { exports: {} as ViewportAddon };
    process.dlopen(module, path);
    addon = module.exports;
  }
  return addon;
}

/**
 * The child window of the Electron window the engine presents into, placed
 * over the area of the page that React reserves. Transparent to the mouse
 * and keyboard: they reach the page. Vulkan presents into it with a
 * swapchain; Dawn gives it its frames read back (an RgbaWindow of
 * DawnWindowSurface). Linux (X11) only so far.
 */
export class X11Viewport implements RgbaWindow {
  readonly window: NativeWindowHandle;
  #handle: unknown;
  #bounds: ViewportBounds = { x: 0, y: 0, width: 0, height: 0 };

  constructor(parent: bigint) {
    this.#handle = loadAddon().createViewport(parent);
    this.window = loadAddon().viewportWindow(this.#handle);
  }

  get bounds(): ViewportBounds {
    return this.#bounds;
  }

  // The size of the area, in pixels (at least one: it may be hidden).
  get width(): number {
    return Math.max(this.#bounds.width, 1);
  }

  get height(): number {
    return Math.max(this.#bounds.height, 1);
  }

  get destroyed(): boolean {
    return this.#handle === undefined;
  }

  /** Moves the window; an empty area unmaps it. */
  setBounds(bounds: ViewportBounds): void {
    const { x, y, width, height } = bounds;
    this.#bounds = bounds;
    loadAddon().setViewportBounds(this.#handle, x, y, width, height);
  }

  /** Keeps the window above those of Chromium: before each frame. */
  pump(): void {
    loadAddon().pumpViewport(this.#handle);
  }

  /** Copies a frame into the window (XShmPutImage): Dawn. */
  presentRgba(
    pixels: Uint8Array,
    width: number,
    height: number,
    stride: number,
  ): void {
    loadAddon().presentViewport(this.#handle, pixels, width, height, stride);
  }

  /** After the swapchain on the window. */
  destroy(): void {
    if (this.#handle === undefined) return;
    loadAddon().destroyViewport(this.#handle);
    this.#handle = undefined;
  }
}
