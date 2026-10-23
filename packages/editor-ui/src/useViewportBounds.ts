import { useEffect, type RefObject } from 'react';
import type { EngineConnection } from './host';

/**
 * Sends the engine the bounds of the area of the viewport, in device
 * pixels, whenever they change; an empty area once unmounted, which hides
 * the viewport. The engine places its window over the area (Electron), or
 * sizes its canvas to it (web).
 */
export function useViewportBounds(
  ref: RefObject<HTMLElement | null>,
  engine: EngineConnection,
): void {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      const scale = window.devicePixelRatio;
      const x = Math.round(rect.left * scale);
      const y = Math.round(rect.top * scale);
      engine.post({
        type: 'bounds',
        x,
        y,
        width: Math.round(rect.right * scale) - x,
        height: Math.round(rect.bottom * scale) - y,
      });
    };
    // Its size by the observer; its position moves with the window size
    // and the zoom (devicePixelRatio), which fire resize.
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      engine.post({ type: 'bounds', x: 0, y: 0, width: 0, height: 0 });
    };
  }, [ref, engine]);
}
