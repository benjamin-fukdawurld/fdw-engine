import { useEffect } from 'react';
import type { EditorHost, EngineConnection } from './host';
import type { EditorPlugin } from './plugins/pluginHost';
import type { EngineMessage, PageMessage } from './protocol';

/**
 * A host without engine, for the tests of the shell and of the plugins
 * (`@fdw/editor-ui/testing`): the messages of the page are kept, those of
 * the engine sent by the test (`send`, to wrap in `act`); the storage is a
 * map, given its first documents; the viewport counts its mounts.
 */
export function fakeHost(
  saved: Readonly<Record<string, unknown>> = {},
  plugins?: readonly EditorPlugin[],
) {
  const posted: PageMessage[] = [];
  const listeners = new Set<(message: EngineMessage) => void>();
  const engine: EngineConnection = {
    post: (message) => posted.push(message),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const stored = new Map<string, unknown>(Object.entries(saved));
  const viewport = { mounts: 0 };
  const host: EditorHost = {
    engine,
    Viewport: function Viewport() {
      useEffect(() => {
        viewport.mounts++;
      }, []);
      return <div data-testid="viewport" />;
    },
    files: {
      open: async () => undefined,
      save: async () => false,
    },
    storage: {
      read: async (key) => stored.get(key),
      write: async (key, value) => {
        stored.set(key, value);
      },
    },
    popoutUrl: 'popout.html',
    about: 'Fake host',
    ...(plugins && { plugins }),
  };
  const send = (message: EngineMessage) =>
    listeners.forEach((listener) => listener(message));
  return { host, posted, send, listeners, stored, viewport };
}

/** The first message of the engine, with two scenes. */
export const readyMessage: Extract<EngineMessage, { type: 'ready' }> = {
  type: 'ready',
  backend: 'vulkan',
  device: 'GPU',
  scenes: ['a', 'b'],
  scene: 'a',
};

/**
 * jsdom has no ResizeObserver, which dockview watches its elements with,
 * nor scrollIntoView, which the palette calls: never resized, never
 * scrolled. The layout itself is tested in Chromium (apps/editor-web).
 */
export function stubLayout(): void {
  globalThis.ResizeObserver ??= class {
    observe() {
      // Never resized.
    }
    unobserve() {
      // Nothing observed.
    }
    disconnect() {
      // Nothing observed.
    }
  };
  Element.prototype.scrollIntoView ??= function scrollIntoView() {
    // Never scrolled.
  };
}
