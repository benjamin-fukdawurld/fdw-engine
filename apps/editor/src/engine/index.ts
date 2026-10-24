// The engine process of the editor: a utility process of Electron, started
// by the main process (src/main/engine.ts), which runs the engine on Vulkan
// and presents into the viewport, a child window of the editor window. The
// main process gives it the XID of that window and the backend asked for
// (FDW_BACKEND), then a port to the page at each page load; the
// EditorEngine of @fdw/editor-ui does the rest. On Dawn (asked for, or the
// fallback), the engine runs in a Node process of its own (dawn.ts), to
// which this one relays the messages of the page. The main process and its
// interface never wait for a frame.
import { startBackend } from '@fdw/editor-ui/engine';
import type { EngineMessage, PageMessage } from '@fdw/editor-ui/protocol';
import { fork, type ChildProcess } from 'node:child_process';
import type { MessagePortMain } from 'electron';
import type {
  ControlMessage,
  DawnControlMessage,
  Wire,
} from '../shared/protocol';
import { fromWire, toWire } from './wire';
import { startVulkan } from './backends';
import { EngineSession, type PageLink } from './session';
import { X11Viewport } from './viewport';

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

// A port to the page, as the session takes it.
function pageLink(port: MessagePortMain): PageLink {
  return {
    post: (message) => port.postMessage(message),
    close: () => port.close(),
    listen: (receive) => {
      port.on('message', ({ data }) => receive(data as PageMessage));
      port.start();
    },
  };
}

/**
 * The Dawn process: the messages of the page relayed to it, its own to the
 * page. It needs a Node of its own (FDW_NODE, else the node of the PATH).
 */
class DawnProcess {
  readonly #child: ChildProcess;
  readonly #exited: Promise<void>;
  #port?: MessagePortMain;

  constructor(parent: string, fallback: string | undefined) {
    // Built from dawn.ts, its path given by the main process.
    this.#child = fork(process.env['FDW_DAWN_PROCESS'] ?? '', [], {
      execPath: process.env['FDW_NODE'] ?? 'node',
      execArgv: [],
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    });
    // 'close' may not come after a failed spawn.
    this.#exited = new Promise((resolve) => {
      this.#child.once('close', () => resolve());
      this.#child.once('error', () => resolve());
    });
    this.#child.on('message', (message) =>
      this.#port?.postMessage(fromWire(message as Wire<EngineMessage>)),
    );
    this.#child.once('error', (error) => {
      console.error('[engine] No Dawn process:', error);
      this.#port?.postMessage({
        type: 'error',
        message: `Dawn needs Node 24 (FDW_NODE): ${errorText(error)}`,
      } satisfies EngineMessage);
    });
    this.#send({ type: 'init', parent, fallback });
  }

  connect(port: MessagePortMain): void {
    this.#port?.close();
    this.#port = port;
    this.#send({ type: 'connect' });
    port.on('message', ({ data }) =>
      this.#send({ type: 'page', message: toWire(data as PageMessage) }),
    );
    port.start();
  }

  setVisible(visible: boolean): void {
    this.#send({ type: 'visible', visible });
  }

  /** Resolves once the process has destroyed its window and exited. */
  get exited(): Promise<void> {
    return this.#exited;
  }

  quit(): void {
    this.#send({ type: 'quit' });
  }

  #send(message: DawnControlMessage): void {
    if (this.#child.connected) this.#child.send(message);
  }
}

const session = new EngineSession();
let dawn: DawnProcess | undefined;
// The port waits here until the backend is chosen: Vulkan in this process
// (the session), or the Dawn process.
let port: MessagePortMain | undefined;
let chosen = false;
let started = false;
let windowVisible = true;

function connect(next: MessagePortMain): void {
  if (dawn) {
    dawn.connect(next);
  } else if (chosen) {
    session.connect(pageLink(next));
  } else {
    port?.close();
    port = next;
  }
}

// Vulkan here, or Dawn in its process, given the window and the reason.
async function run(parent: string, requested?: string): Promise<void> {
  const viewport = new X11Viewport(BigInt(parent));
  const backend = await startBackend(
    requested,
    { name: 'vulkan', start: () => startVulkan(viewport) },
    { name: 'dawn', start: async () => undefined },
  );
  chosen = true;
  const renderer = backend.value;
  if (renderer) {
    if (port) connect(port);
    await session.run(viewport, async () => ({ ...backend, value: renderer }));
    return;
  }
  viewport.destroy();
  dawn = new DawnProcess(parent, backend.fallback);
  dawn.setVisible(windowVisible);
  if (port) connect(port);
  await dawn.exited;
}

process.parentPort.on('message', ({ data, ports }) => {
  const message = data as ControlMessage;
  switch (message.type) {
    case 'init':
      started = true;
      void run(message.parent, message.backend)
        .catch((error) => console.error('[engine]', error))
        .finally(() => process.exit(0));
      break;
    case 'connect':
      if (ports[0]) connect(ports[0]);
      break;
    case 'visible':
      windowVisible = message.visible;
      session.setVisible(message.visible);
      dawn?.setVisible(message.visible);
      break;
    case 'quit':
      session.stop();
      dawn?.quit();
      if (!started) process.exit(0);
      break;
  }
});
