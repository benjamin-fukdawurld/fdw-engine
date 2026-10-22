import { useEffect, useRef } from 'react';

/**
 * The area of the page where the native viewport is shown: measured, and
 * its bounds in device pixels sent to the native layer, which places its
 * window over it. The element itself stays empty.
 */
export function Viewport() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      const scale = window.devicePixelRatio;
      const x = Math.round(rect.left * scale);
      const y = Math.round(rect.top * scale);
      window.editor.setViewportBounds({
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
      window.editor.setViewportBounds({ x: 0, y: 0, width: 0, height: 0 });
    };
  }, []);

  return <div ref={ref} style={{ width: '100%', height: '100%' }} />;
}
