import type { GamepadState, InputSink } from '@fdw/engine-input';
import { WebInputSource } from '@fdw/engine-input-web';
import { useEffect, useRef } from 'react';
import type { InputCall } from '../../shared/protocol';
import { engine } from './engine';

// An InputSink sending its calls to the engine, which replays them.
const forward =
  <K extends keyof InputSink>(method: K) =>
  (...args: Parameters<InputSink[K]>) =>
    engine.post({ type: 'input', ...({ method, args } as InputCall) });

const sink: InputSink = {
  keyDown: forward('keyDown'),
  keyUp: forward('keyUp'),
  pointerMove: forward('pointerMove'),
  pointerLock: forward('pointerLock'),
  pointerButton: forward('pointerButton'),
  wheel: forward('wheel'),
  blur: forward('blur'),
};

/**
 * The area of the page where the engine shows its viewport: measured, and
 * its bounds in device pixels sent to the engine, which places its window
 * over it. The element stays empty, but receives the inputs: that window
 * lets them through. Read by a WebInputSource, as a canvas would be, and
 * sent to the engine; the pointer locks to the element.
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
  }, []);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const source = new WebInputSource(element);
    source.attach(sink);
    const unsubscribe = engine.subscribe((message) => {
      if (message.type === 'pointerLock') {
        source.setPointerLock(message.locked);
      } else if (message.type === 'rumble') {
        const { gamepad, strong, weak, duration } = message;
        source.rumble(gamepad, strong, weak, duration);
      }
    });
    // The gamepads are polled: sent at each animation frame while there
    // are some, once more when the last one goes.
    const states: GamepadState[] = [];
    let count = 0;
    let frame = requestAnimationFrame(function poll() {
      const next = source.readGamepads(states);
      if (next > 0 || count > 0) {
        engine.post({ type: 'gamepads', states: states.slice(0, next) });
      }
      count = next;
      frame = requestAnimationFrame(poll);
    });
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
      source.detach();
    };
  }, []);

  return (
    <div
      ref={ref}
      // Focusable, to receive the keys once clicked.
      tabIndex={0}
      onPointerDown={(event) => {
        event.currentTarget.focus();
        // A drag goes on outside of the viewport.
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onContextMenu={(event) => event.preventDefault()}
      style={{ width: '100%', height: '100%', outline: 'none' }}
    />
  );
}
