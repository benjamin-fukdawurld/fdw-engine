import type { GamepadState, InputSink } from '@fdw/engine-input';
import { WebInputSource } from '@fdw/engine-input-web';
import { useEffect, useRef } from 'react';
import type { EngineConnection } from './host';
import type { InputCall } from './protocol';
import { useViewportBounds } from './useViewportBounds';
import { viewportHoles } from './viewportHoles';

// An InputSink sending its calls to the engine, which replays them.
function remoteSink(engine: EngineConnection): InputSink {
  const forward =
    <K extends keyof InputSink>(method: K) =>
    (...args: Parameters<InputSink[K]>) =>
      engine.post({ type: 'input', ...({ method, args } as InputCall) });
  return {
    keyDown: forward('keyDown'),
    keyUp: forward('keyUp'),
    pointerMove: forward('pointerMove'),
    pointerLock: forward('pointerLock'),
    pointerButton: forward('pointerButton'),
    wheel: forward('wheel'),
    blur: forward('blur'),
  };
}

/**
 * The viewport of an engine out of the page (the utility process of
 * Electron): the area where the engine shows its view, measured, and
 * its bounds in device pixels sent to the engine, which places its window
 * over it. The element stays empty, but receives the inputs: that window
 * lets them through. Read by a WebInputSource, as a canvas would be, and
 * sent to the engine; the pointer locks to the element. The menus and
 * floating panels over the area are sent as holes, which the window leaves
 * out.
 */
export function RemoteViewport({
  engine,
}: {
  readonly engine: EngineConnection;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useViewportBounds(ref, engine);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const source = new WebInputSource(element);
    source.attach(remoteSink(engine));
    const unsubscribe = engine.subscribe((message) => {
      if (message.type === 'pointerLock') {
        source.setPointerLock(message.locked);
      } else if (message.type === 'rumble') {
        const { gamepad, strong, weak, duration } = message;
        source.rumble(gamepad, strong, weak, duration);
      }
    });
    // The gamepads are polled: sent at each animation frame while there
    // are some, once more when the last one goes. The holes too: the menus
    // and floating panels over the viewport.
    const states: GamepadState[] = [];
    let count = 0;
    let holes = '[]';
    let frame = requestAnimationFrame(function poll() {
      const next = source.readGamepads(states);
      if (next > 0 || count > 0) {
        engine.post({ type: 'gamepads', states: states.slice(0, next) });
      }
      count = next;
      const over = viewportHoles(element);
      const key = JSON.stringify(over);
      if (key !== holes) {
        holes = key;
        engine.post({ type: 'holes', holes: over });
      }
      frame = requestAnimationFrame(poll);
    });
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
      source.detach();
    };
  }, [engine]);

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
