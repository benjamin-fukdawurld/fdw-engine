// The engine process of the editor: a utility process of Electron, started
// by the main process (src/main/engine.ts), which runs the engine on Vulkan
// and presents into the viewport, a child window of the editor window. The
// main process gives it the XID of that window, then a port to the page
// at each page load; the EditorEngine of @fdw/editor-ui does the rest. The
// main process and its interface never wait for a frame.
import { EditorEngine, type EditorEnginePlatform } from '@fdw/editor-ui/engine';
import type { EngineMessage, PageMessage } from '@fdw/editor-ui/protocol';
import { NativeAudioEngine } from '@fdw/engine-audio-native';
import { VulkanEngine } from '@fdw/engine-vulkan';
import type { MessagePortMain } from 'electron';
import type { ControlMessage } from '../shared/protocol';
import { scenes } from './scenes';
import { ViewportSurface } from './ViewportSurface';
import { X11Viewport } from './viewport';

// The scene shown first (FDW_SCENE chooses another).
const defaultScene = process.env['FDW_SCENE'] ?? 'shadows';

let quitting = false;
let viewport: X11Viewport | undefined;
let engine: VulkanEngine | undefined;
let surface: ViewportSurface | undefined;
let audio: NativeAudioEngine | undefined;
let editor: EditorEngine | undefined;
// The last port to the page; its messages wait in it until the engine is
// ready.
let port: MessagePortMain | undefined;
let windowVisible = true;

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function connect(next: MessagePortMain): void {
  if (!editor) {
    port?.close();
    port = next;
    return;
  }
  const target = editor;
  port = next;
  target.connect({
    post: (message) => next.postMessage(message),
    close: () => next.close(),
  });
  next.on('message', ({ data }) => target.receive(data as PageMessage));
  next.start();
}

async function run(parent: bigint): Promise<void> {
  const window = new X11Viewport(parent);
  viewport = window;
  const vulkan = new VulkanEngine({
    application: 'FDW Editor',
    validation: process.env['FDW_VALIDATION'] === '1',
  });
  engine = vulkan;
  await vulkan.init();
  const { backend, device } = vulkan;
  if (!backend || !device) throw new Error('The Vulkan engine is not ready');
  try {
    audio = new NativeAudioEngine();
  } catch (error) {
    console.warn(`[engine] No audio: ${errorText(error)}`);
  }
  const platform: EditorEnginePlatform = {
    backend,
    device: device.name,
    viewport: window,
    createSurface: async () => {
      surface = new ViewportSurface(window);
      await surface.init(vulkan);
      return surface;
    },
    waitIdle: () => device.waitIdle(),
    nextFrame: () => new Promise((resolve) => setImmediate(resolve)),
    scenes,
    audio,
  };
  editor = new EditorEngine(platform, defaultScene);
  editor.setVisible(windowVisible);
  if (port) connect(port);
  if (!quitting) await editor.run();
}

async function shutdown(): Promise<void> {
  editor?.destroy();
  const messages = engine?.device?.takeMessages() ?? [];
  if (messages.length > 0) {
    console.log(`[engine] Vulkan validation:\n${messages.join('\n')}`);
  }
  audio?.destroy();
  surface?.destroy();
  viewport?.destroy();
  await engine?.destroy();
}

let started = false;
process.parentPort.on('message', ({ data, ports }) => {
  const message = data as ControlMessage;
  switch (message.type) {
    case 'init':
      started = true;
      void run(BigInt(message.parent))
        .catch((error) => {
          console.error('[engine]', error);
          port?.postMessage({
            type: 'error',
            message: errorText(error),
          } satisfies EngineMessage);
        })
        .then(shutdown)
        .finally(() => process.exit(0));
      break;
    case 'connect':
      if (ports[0]) connect(ports[0]);
      break;
    case 'visible':
      windowVisible = message.visible;
      editor?.setVisible(message.visible);
      break;
    case 'quit':
      quitting = true;
      editor?.stop();
      if (!started) process.exit(0);
      break;
  }
});
