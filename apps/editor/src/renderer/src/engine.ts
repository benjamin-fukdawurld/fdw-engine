import type {
  EngineConnection,
  EngineMessage,
  PageMessage,
} from '@fdw/editor-ui';

type Listener = (message: EngineMessage) => void;

// What the page tells the engine before the port comes: kept for it.
const kept = new Set<PageMessage['type']>([
  'bounds',
  'scene',
  'level.tool',
  'level.gizmo',
]);

/**
 * The connection of the page to the engine process, over the port the main
 * process gives it. The bounds, the scene, the tool and the gizmo sent
 * before the port comes wait for it; the inputs are dropped.
 */
class PortConnection implements EngineConnection {
  #port?: MessagePort;
  #pending: PageMessage[] = [];
  readonly #listeners = new Set<Listener>();

  constructor() {
    window.addEventListener('message', (event) => {
      const port = event.ports[0];
      if (event.source !== window || event.data !== 'engine:port' || !port) {
        return;
      }
      this.#port?.close();
      this.#port = port;
      port.onmessage = ({ data }) => {
        this.#listeners.forEach((listener) => listener(data as EngineMessage));
      };
      this.#pending.forEach((message) => port.postMessage(message));
      this.#pending = [];
    });
    window.editor.connectEngine();
  }

  post(message: PageMessage): void {
    if (this.#port) {
      this.#port.postMessage(message);
    } else if (kept.has(message.type)) {
      this.#pending.push(message);
    }
  }

  /** Listens to the messages of the engine; returns the unsubscription. */
  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

export const engine = new PortConnection();
