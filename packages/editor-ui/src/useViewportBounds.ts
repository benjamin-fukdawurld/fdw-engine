import { useEffect, type RefObject } from 'react';
import type { EngineConnection } from './host';
import type { ViewportBounds } from './protocol';

const empty: ViewportBounds = { x: 0, y: 0, width: 0, height: 0 };

/** The bounds of a rectangle of the page in device pixels. */
export function devicePixels(
  rect: Pick<DOMRectReadOnly, 'left' | 'top' | 'right' | 'bottom'>,
): ViewportBounds {
  const scale = window.devicePixelRatio;
  const x = Math.round(rect.left * scale);
  const y = Math.round(rect.top * scale);
  return {
    x,
    y,
    width: Math.round(rect.right * scale) - x,
    height: Math.round(rect.bottom * scale) - y,
  };
}

/**
 * The bounds of the element in device pixels; empty when it is not shown.
 * A panel behind another tab stays laid out, hidden by `visibility`
 * (the `always` renderer of dockview).
 */
export function viewportBounds(element: Element): ViewportBounds {
  if (
    !element.isConnected ||
    element.checkVisibility?.({ visibilityProperty: true }) === false
  ) {
    return empty;
  }
  return devicePixels(element.getBoundingClientRect());
}

const same = (a: ViewportBounds, b: ViewportBounds) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/**
 * Sends the engine the bounds of the area of the viewport, in device
 * pixels, whenever they change; an empty area while it is hidden or once
 * unmounted, which hides the viewport. The engine places its window over
 * the area (Electron), or sizes its canvas to it (web).
 */
export function useViewportBounds(
  ref: RefObject<HTMLElement | null>,
  engine: EngineConnection,
): void {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let sent: ViewportBounds | undefined;
    // Read at each animation frame: the area moves without changing size
    // (a dock shown, a group moved), or is hidden behind another tab, which
    // no observer tells.
    const update = () => {
      const bounds = viewportBounds(element);
      if (!sent || !same(sent, bounds)) {
        sent = bounds;
        engine.post({ type: 'bounds', ...bounds });
      }
      frame = requestAnimationFrame(update);
    };
    let frame = requestAnimationFrame(update);
    return () => {
      cancelAnimationFrame(frame);
      engine.post({ type: 'bounds', ...empty });
    };
  }, [ref, engine]);
}
