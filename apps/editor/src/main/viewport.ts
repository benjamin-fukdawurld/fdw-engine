import type { BrowserWindow } from 'electron';
import { join } from 'node:path';

/** The bounds of the viewport in the window, in device pixels. */
export interface ViewportBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

// The addon of native/ (built by scripts/build-native.mjs).
interface ViewportAddon {
  createViewport(parentWindow: Buffer): unknown;
  setViewportBounds(
    viewport: unknown,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void;
  destroyViewport(viewport: unknown): void;
}

let addon: ViewportAddon | undefined;

// process.dlopen rather than require: the bundler leaves it alone.
function loadAddon(): ViewportAddon {
  if (!addon) {
    const module = { exports: {} as ViewportAddon };
    process.dlopen(module, join(__dirname, '../../build/fdw_editor.node'));
    addon = module.exports;
  }
  return addon;
}

/**
 * The native viewport of a window: a child window rendered with Vulkan on a
 * thread of its own, placed over the area of the page that React reserves.
 * Linux (X11) only so far.
 */
export class NativeViewport {
  #handle: unknown;

  constructor(window: BrowserWindow) {
    this.#handle = loadAddon().createViewport(window.getNativeWindowHandle());
  }

  setBounds({ x, y, width, height }: ViewportBounds): void {
    if (this.#handle === undefined) return;
    loadAddon().setViewportBounds(this.#handle, x, y, width, height);
  }

  /** Stops the render thread; before the window is destroyed. */
  destroy(): void {
    if (this.#handle === undefined) return;
    loadAddon().destroyViewport(this.#handle);
    this.#handle = undefined;
  }
}
