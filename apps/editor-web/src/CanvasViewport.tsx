import { useViewportBounds } from '@fdw/editor-ui';
import { useEffect, useRef } from 'react';
import type { WebEngine } from './engine';

/**
 * The viewport of the engine in the page: the element of the engine, with
 * its canvas, placed in the area. The element outlives the component, so
 * that the canvas and its context survive a remount; the bounds of the
 * area size the canvas, in device pixels.
 */
export function CanvasViewport({ engine }: { readonly engine: WebEngine }) {
  const ref = useRef<HTMLDivElement>(null);

  useViewportBounds(ref, engine.connection);

  useEffect(() => {
    const area = ref.current;
    if (!area) return;
    const { element } = engine;
    const focus = (event: PointerEvent) => {
      element.focus();
      // A drag goes on outside of the viewport.
      element.setPointerCapture(event.pointerId);
    };
    const noMenu = (event: Event) => event.preventDefault();
    element.addEventListener('pointerdown', focus);
    element.addEventListener('contextmenu', noMenu);
    area.append(element);
    return () => {
      element.removeEventListener('pointerdown', focus);
      element.removeEventListener('contextmenu', noMenu);
      element.remove();
    };
  }, [engine]);

  return (
    <div
      ref={ref}
      data-testid="viewport"
      style={{ width: '100%', height: '100%', minWidth: 0, minHeight: 0 }}
    />
  );
}
