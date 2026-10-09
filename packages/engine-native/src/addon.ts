import { createRequire } from 'node:module';

// The Node-API addon (native/src/node_window.c), built by scripts/build.mjs.

/** An opaque handle of a native window. */
export type WindowHandle = { readonly __window: unique symbol };

/** An event of a native window, as read from the addon. */
export interface RawWindowEvent {
  readonly type:
    | 'close'
    | 'resize'
    | 'keydown'
    | 'keyup'
    | 'pointermove'
    | 'pointerdown'
    | 'pointerup'
    | 'wheel';
  readonly window: number;
  readonly width?: number;
  readonly height?: number;
  readonly x?: number;
  readonly y?: number;
  readonly dx?: number;
  readonly dy?: number;
  readonly button?: number;
  readonly key?: string;
  readonly repeat?: number;
  readonly modifiers?: number;
}

export interface NativeAddon {
  init(): void;
  quit(): void;
  createWindow(
    title: string,
    width: number,
    height: number,
    flags: number
  ): WindowHandle;
  destroyWindow(window: WindowHandle): void;
  windowId(window: WindowHandle): number;
  // The size in pixels.
  windowSize(window: WindowHandle): [number, number];
  setTitle(window: WindowHandle, title: string): void;
  setVsync(window: WindowHandle, vsync: number): void;
  // RGBA pixels, `stride` bytes per row.
  presentRgba(
    window: WindowHandle,
    pixels: Uint8Array,
    width: number,
    height: number,
    stride: number
  ): void;
  pollEvents(): RawWindowEvent[];
  // The window system and the native handles of a window.
  nativeHandle(window: WindowHandle): NativeHandle;
}

/** The window system of a window and its native handles. */
export interface NativeHandle {
  readonly system: 'x11' | 'wayland' | 'win32' | 'cocoa' | 'unknown';
  readonly display: bigint;
  readonly window: bigint;
}

// The flags of createWindow (include/fdw/window.h).
export const WindowFlags = {
  resizable: 1 << 0,
  hidden: 1 << 1,
  fullscreen: 1 << 2,
  vulkan: 1 << 3,
} as const;

// The modifiers of the events.
export const Modifiers = {
  shift: 1 << 0,
  ctrl: 1 << 1,
  alt: 1 << 2,
  meta: 1 << 3,
} as const;

let addon: NativeAddon | undefined;

/**
 * Loads the addon: build/fdw_native.node of the package, or the file given
 * by the FDW_NATIVE_ADDON environment variable.
 */
export function loadAddon(): NativeAddon {
  if (!addon) {
    const require = createRequire(import.meta.url);
    const path =
      process.env['FDW_NATIVE_ADDON'] ??
      new URL('../build/fdw_native.node', import.meta.url).pathname;
    try {
      addon = require(path) as NativeAddon;
    } catch (error) {
      throw new Error(
        `The native addon of @fdw/engine-native is not built (${path}): run "node packages/engine-native/scripts/build.mjs"`,
        { cause: error }
      );
    }
  }
  return addon;
}

/** Replaces the addon, for tests. */
export function setAddon(replacement: NativeAddon | undefined): void {
  addon = replacement;
}
