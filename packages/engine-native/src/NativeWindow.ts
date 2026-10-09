import {
  loadAddon,
  Modifiers,
  NativeAddon,
  RawWindowEvent,
  WindowFlags,
  WindowHandle,
} from './addon';

export interface NativeWindowOptions {
  readonly title?: string;
  // Size in logical units; the size in pixels can be larger on high density
  // displays.
  readonly width?: number;
  readonly height?: number;
  readonly resizable?: boolean;
  readonly hidden?: boolean;
  readonly fullscreen?: boolean;
  // The window will be presented by Vulkan (no copy presentation then).
  readonly vulkan?: boolean;
}

/**
 * An event of a native window, with the fields of its DOM counterpart:
 * `width` and `height` for 'resize'; `key`, `repeat` and the modifiers for
 * the key events; `x`, `y` (pixels from the top left corner), `button`,
 * `dx`, `dy` and the modifiers for the pointer and wheel events.
 */
export class NativeWindowEvent extends Event {
  readonly width: number;
  readonly height: number;
  readonly key: string;
  readonly repeat: boolean;
  readonly x: number;
  readonly y: number;
  readonly dx: number;
  readonly dy: number;
  readonly button: number;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;

  constructor(raw: RawWindowEvent) {
    super(raw.type);
    this.width = raw.width ?? 0;
    this.height = raw.height ?? 0;
    this.key = raw.key ?? '';
    this.repeat = (raw.repeat ?? 0) !== 0;
    this.x = raw.x ?? 0;
    this.y = raw.y ?? 0;
    this.dx = raw.dx ?? 0;
    this.dy = raw.dy ?? 0;
    this.button = raw.button ?? 0;
    const modifiers = raw.modifiers ?? 0;
    this.shiftKey = (modifiers & Modifiers.shift) !== 0;
    this.ctrlKey = (modifiers & Modifiers.ctrl) !== 0;
    this.altKey = (modifiers & Modifiers.alt) !== 0;
    this.metaKey = (modifiers & Modifiers.meta) !== 0;
  }
}

// The open windows, by id, to dispatch the events; the video subsystem is
// initialized while there are some.
const windows = new Map<number, NativeWindow>();

/**
 * A native window (SDL3), outside of the browser. Its events ('close',
 * 'resize', 'keydown', 'keyup', 'pointermove', 'pointerdown', 'pointerup',
 * 'wheel') are dispatched by NativeWindow.pollEvents(), called by runLoop.
 * Closing it is up to the application: listen to 'close' and call destroy().
 */
export class NativeWindow extends EventTarget {
  readonly id: number;
  private readonly _addon: NativeAddon;
  private _handle?: WindowHandle;
  private _width: number;
  private _height: number;

  constructor({
    title = 'FdwEngine',
    width = 1280,
    height = 720,
    resizable = true,
    hidden = false,
    fullscreen = false,
    vulkan = false,
  }: NativeWindowOptions = {}) {
    super();
    this._addon = loadAddon();
    if (windows.size === 0) {
      this._addon.init();
    }
    this._handle = this._addon.createWindow(
      title,
      width,
      height,
      (resizable ? WindowFlags.resizable : 0) |
        (hidden ? WindowFlags.hidden : 0) |
        (fullscreen ? WindowFlags.fullscreen : 0) |
        (vulkan ? WindowFlags.vulkan : 0)
    );
    this.id = this._addon.windowId(this._handle);
    [this._width, this._height] = this._addon.windowSize(this._handle);
    windows.set(this.id, this);
  }

  /** Dispatches the pending events of every window to their window. */
  static pollEvents(): void {
    if (windows.size === 0) {
      return;
    }
    const addon = loadAddon();
    for (const raw of addon.pollEvents()) {
      windows.get(raw.window)?.receive(raw);
    }
  }

  // The size in pixels: the size of the images presented.
  get width(): number {
    return this._width;
  }

  get height(): number {
    return this._height;
  }

  get destroyed(): boolean {
    return this._handle === undefined;
  }

  set title(title: string) {
    this._addon.setTitle(this.handle, title);
  }

  // Copy presentation: waits for the vertical synchronization (default).
  set vsync(vsync: boolean) {
    this._addon.setVsync(this.handle, vsync ? 1 : 0);
  }

  /**
   * Shows an image (RGBA, 8 bits per channel, `stride` bytes per row), scaled
   * to the window.
   */
  presentRgba(
    pixels: Uint8Array,
    width: number,
    height: number,
    stride = width * 4
  ): void {
    this._addon.presentRgba(this.handle, pixels, width, height, stride);
  }

  destroy(): void {
    if (!this._handle) {
      return;
    }
    this._addon.destroyWindow(this._handle);
    this._handle = undefined;
    windows.delete(this.id);
    if (windows.size === 0) {
      this._addon.quit();
    }
  }

  private get handle(): WindowHandle {
    if (!this._handle) {
      throw new Error('The window was destroyed');
    }
    return this._handle;
  }

  private receive(raw: RawWindowEvent): void {
    if (raw.type === 'resize') {
      this._width = raw.width ?? this._width;
      this._height = raw.height ?? this._height;
    }
    this.dispatchEvent(new NativeWindowEvent(raw));
  }
}
