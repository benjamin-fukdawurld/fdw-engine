// The keyboard and the mouse, the same in a browser (a window, a canvas)
// and in a native window, whose events are DOM-like too: key names differ
// (`ArrowUp` in a browser, `Up` with SDL), and are normalized here.

const aliases: Record<string, string> = {
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  ' ': 'space',
  'left shift': 'shift',
  'right shift': 'shift',
  esc: 'escape',
};

/** A key name, the same everywhere: `w`, `up`, `space`, `shift`… */
export function normalizeKey(key: string): string {
  const lower = key.toLowerCase();
  return aliases[lower] ?? lower;
}

/**
 * The state of the keyboard and the mouse, read each frame by the game:
 * which keys are down, how much the wheel turned, where the pointer is.
 */
export class Input {
  private readonly _down = new Set<string>();
  // The keys pressed since they were last read by `pressed`: a press
  // shorter than a frame is not lost.
  private readonly _presses = new Set<string>();
  private _wheel = 0;
  // In [0, 1] over the element or window receiving the events, from the
  // top left: the same in a browser and in a native window.
  private _pointer = { x: 0.5, y: 0.5 };
  private _pointerMoved = false;
  private readonly _remove: (() => void)[] = [];

  constructor(target: EventTarget) {
    const listen = (type: string, listener: (event: Event) => void) => {
      target.addEventListener(type, listener);
      this._remove.push(() => target.removeEventListener(type, listener));
    };
    listen('keydown', (event) => {
      const key = normalizeKey((event as KeyboardEvent).key);
      // Not the repeats of a key held down.
      if (!this._down.has(key)) {
        this._presses.add(key);
      }
      this._down.add(key);
    });
    listen('keyup', (event) => {
      this._down.delete(normalizeKey((event as KeyboardEvent).key));
    });
    listen('wheel', (event) => {
      // DOM: deltaY, pixels down; native: dy, steps up.
      const wheel = event as WheelEvent & { dy?: number };
      this._wheel += wheel.dy !== undefined ? -wheel.dy * 100 : wheel.deltaY;
    });
    listen('pointermove', (event) => {
      // DOM: offsetX in the element, whose size is clientWidth; native:
      // x in the window, whose size is width.
      const pointer = event as PointerEvent & { x: number; y: number };
      const target = event.target as {
        clientWidth?: number;
        clientHeight?: number;
        width?: number;
        height?: number;
      } | null;
      const width = target?.clientWidth ?? target?.width ?? 1;
      const height = target?.clientHeight ?? target?.height ?? 1;
      this._pointer = {
        x: (pointer.offsetX ?? pointer.x) / Math.max(width, 1),
        y: (pointer.offsetY ?? pointer.y) / Math.max(height, 1),
      };
      this._pointerMoved = true;
    });
    // Keys released while the window lost the focus.
    listen('blur', () => this._down.clear());
  }

  isDown(...keys: string[]): boolean {
    return keys.some((key) => this._down.has(key));
  }

  /**
   * Whether a key was pressed since the last call for it: once per press,
   * even released before the frame.
   */
  pressed(key: string): boolean {
    return this._presses.delete(key);
  }

  /** -1, 0 or 1: the axis of two sets of keys (`axis(['s'], ['w'])`). */
  axis(negative: readonly string[], positive: readonly string[]): number {
    return (
      (this.isDown(...positive) ? 1 : 0) - (this.isDown(...negative) ? 1 : 0)
    );
  }

  /** The wheel turned since the last call, in pixels (positive: down). */
  takeWheel(): number {
    const wheel = this._wheel;
    this._wheel = 0;
    return wheel;
  }

  /** The pointer, from 0 to 1 over the surface, from the top left. */
  get pointer(): { readonly x: number; readonly y: number } {
    return this._pointer;
  }

  /** Whether the pointer moved at least once. */
  get pointerMoved(): boolean {
    return this._pointerMoved;
  }

  dispose(): void {
    this._remove.forEach((remove) => remove());
  }
}
