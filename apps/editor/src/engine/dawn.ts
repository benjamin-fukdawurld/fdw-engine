// The Dawn process of the editor: the fallback of the engine process
// (index.ts) when Vulkan does not start, or FDW_BACKEND=dawn. A plain Node
// process (FDW_NODE, else the node of the PATH), not an Electron one: the
// V8 of Electron refuses the external ArrayBuffers that dawn.node makes at
// each getMappedRange. It runs the same EngineSession, on Dawn, in a
// viewport of its own; the engine process relays the messages of the page
// over the IPC of Node.
import type { EngineMessage, PageMessage } from '@fdw/editor-ui/protocol';
import type { DawnControlMessage } from '../shared/protocol';
import { fromWire, toWire } from './wire';
import { startDawn } from './backends';
import { EngineSession, type PageLink } from './session';
import { X11Viewport } from './viewport';

const send = (message: EngineMessage) => process.send?.(toWire(message));
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

// The engine is written for Node 24: the node of the PATH may be older.
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 24) {
  send({
    type: 'error',
    message: `Dawn needs Node 24, not ${process.version} (FDW_NODE)`,
  });
  process.exit(1);
}

// The page of the last 'connect': its messages wait until the engine
// listens to them.
let queue: PageMessage[] = [];
let receive: ((message: PageMessage) => void) | undefined;

function page(): PageLink {
  queue = [];
  receive = undefined;
  return {
    post: send,
    close: () => undefined,
    listen: (listener) => {
      receive = listener;
      queue.forEach(listener);
      queue = [];
    },
  };
}

const session = new EngineSession();
session.connect(page());

let started = false;
const quit = () => {
  session.stop();
  if (!started) process.exit(0);
};

process.on('message', (data) => {
  const message = data as DawnControlMessage;
  switch (message.type) {
    case 'init': {
      started = true;
      const viewport = new X11Viewport(BigInt(message.parent));
      void session
        .run(viewport, async () => {
          const { fallback } = message;
          try {
            return { name: 'dawn', value: await startDawn(viewport), fallback };
          } catch (error) {
            // With the reason of the fallback, when Dawn was the fallback.
            const after = fallback ? ` (after ${fallback})` : '';
            throw new Error(`dawn: ${errorText(error)}${after}`);
          }
        })
        .finally(() => process.exit(0));
      break;
    }
    case 'connect':
      session.connect(page());
      break;
    case 'page':
      if (receive) receive(fromWire<PageMessage>(message.message));
      else queue.push(fromWire<PageMessage>(message.message));
      break;
    case 'visible':
      session.setVisible(message.visible);
      break;
    case 'quit':
      quit();
      break;
  }
});
// The engine process is gone (killed): the window goes with it.
process.on('disconnect', quit);
