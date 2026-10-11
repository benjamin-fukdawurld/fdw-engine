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
  private _wheel = 0;
  private _pointer = { x: 0, y: 0 };
  private readonly _remove: (() => void)[] = [];

  constructor(target: EventTarget) {
    const listen = (type: string, listener: (event: Event) => void) => {
      target.addEventListener(type, listener);
      this._remove.push(() => target.removeEventListener(type, listener));
    };
    listen('keydown', (event) => {
      this._down.add(normalizeKey((event as KeyboardEvent).key));
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
      const pointer = event as PointerEvent;
      this._pointer = {
        x: pointer.offsetX ?? pointer.x,
        y: pointer.offsetY ?? pointer.y,
      };
    });
    // Keys released while the window lost the focus.
    listen('blur', () => this._down.clear());
  }

  isDown(...keys: string[]): boolean {
    return keys.some((key) => this._down.has(key));
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

  get pointer(): { readonly x: number; readonly y: number } {
    return this._pointer;
  }

  dispose(): void {
    this._remove.forEach((remove) => remove());
  }
}
