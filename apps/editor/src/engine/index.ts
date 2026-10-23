// The engine process of the editor: a utility process of Electron, started
// by the main process (src/main/engine.ts), which runs the engine on Vulkan
// and presents into the viewport, a child window of the editor window. The
// main process gives it the XID of that window, then a port to the page
// at each page load; the page sends the bounds of the viewport, the scene to
// show and its inputs over it. The main process and its interface never
// wait for a frame.
import type { Scene } from '@fdw/demo-scenes';
import type { EngineMessage, PageMessage } from '@fdw/editor-ui/protocol';
import { NativeAudioEngine } from '@fdw/engine-audio-native';
import type { GamepadState } from '@fdw/engine-input';
import { VulkanEngine } from '@fdw/engine-vulkan';
import type { MessagePortMain } from 'electron';
import type { ControlMessage } from '../shared/protocol';
import { RemoteInputSource } from './RemoteInputSource';
import { scenes } from './scenes';
import { ViewportSurface } from './ViewportSurface';
import { X11Viewport } from './viewport';

// The scene shown first (FDW_SCENE chooses another).
const defaultScene = process.env['FDW_SCENE'] ?? 'shadows';

// The scene in the viewport.
interface Shown {
  readonly name: string;
  readonly scene: Scene;
  readonly input: RemoteInputSource;
  readonly start: number;
  // Set by the scene (SceneContext.info).
  info: string;
}

let running = true;
let port: MessagePortMain | undefined;
let viewport: X11Viewport | undefined;
let engine: VulkanEngine | undefined;
let surface: ViewportSurface | undefined;
let audio: NativeAudioEngine | undefined;
let shown: Shown | undefined;
// The scene asked for, and the number of the last request: a scene still
// loading when another is asked for is dropped.
let requested = defaultScene;
let requests = 0;
// Whether the window is minimized or hidden.
let windowVisible = true;
let gamepads: readonly GamepadState[] = [];

const post = (message: EngineMessage) => port?.postMessage(message);
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const yieldToNode = () => new Promise<void>((resolve) => setImmediate(resolve));
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

// Whether the viewport is on screen: frames are only drawn then.
const onScreen = () =>
  windowVisible &&
  viewport !== undefined &&
  viewport.bounds.width > 0 &&
  viewport.bounds.height > 0;

function sendReady(): void {
  if (engine?.device) {
    post({
      type: 'ready',
      device: engine.device.name,
      scenes: Object.keys(scenes),
      scene: requested,
    });
  }
}

function connect(next: MessagePortMain): void {
  port?.close();
  port = next;
  port.on('message', ({ data }) => receive(data as PageMessage));
  port.start();
  sendReady();
}

function receive(message: PageMessage): void {
  switch (message.type) {
    case 'bounds':
      viewport?.setBounds(message);
      break;
    case 'scene':
      if (message.name !== requested) {
        requested = message.name;
        if (surface) void showScene(message.name);
      }
      break;
    case 'input':
      shown?.input.receive(message);
      break;
    case 'gamepads':
      gamepads = message.states;
      shown?.input.setGamepads(gamepads);
      break;
  }
}

function hideScene(): void {
  if (!shown) return;
  // The frames in flight still use its resources.
  engine?.device?.waitIdle();
  shown.scene.destroy();
  shown = undefined;
  // A lock taken by the scene is released.
  post({ type: 'pointerLock', locked: false });
}

async function showScene(name: string): Promise<void> {
  const request = ++requests;
  const load = scenes[name];
  if (!load) {
    post({ type: 'error', message: `No scene named ${name}` });
    return;
  }
  post({ type: 'loading', scene: name });
  try {
    const factory = await load();
    const backend = engine?.backend;
    if (request !== requests || !running || !backend || !surface) return;
    hideScene();
    const input = new RemoteInputSource(post);
    input.setGamepads(gamepads);
    const context = { info: '' };
    const scene = factory(backend, surface, {
      input,
      audio,
      info: (text) => {
        context.info = text;
      },
    });
    shown = Object.assign(context, {
      name,
      scene,
      input,
      start: performance.now(),
    });
  } catch (error) {
    post({ type: 'error', message: `${name}: ${errorText(error)}` });
  }
}

async function run(parent: bigint): Promise<void> {
  viewport = new X11Viewport(parent);
  engine = new VulkanEngine({
    application: 'FDW Editor',
    validation: process.env['FDW_VALIDATION'] === '1',
  });
  await engine.init();
  try {
    audio = new NativeAudioEngine();
  } catch (error) {
    console.warn(`[engine] No audio: ${errorText(error)}`);
  }
  sendReady();

  // The swapchain needs a window with an area, and the scenes its format.
  while (running && !onScreen()) {
    viewport.pump();
    await sleep(16);
  }
  if (!running) return;
  surface = new ViewportSurface(viewport);
  await surface.init(engine);
  void showScene(requested);

  let second = performance.now();
  let frames = 0;
  while (running) {
    viewport.pump();
    if (shown && onScreen()) {
      try {
        shown.scene.frame((performance.now() - shown.start) / 1000);
        frames++;
      } catch (error) {
        post({ type: 'error', message: `${shown.name}: ${errorText(error)}` });
        hideScene();
      }
      // Between two frames: the messages of the page, I/O, promises.
      await yieldToNode();
    } else {
      await sleep(16);
    }
    const now = performance.now();
    if (now - second >= 1000) {
      post({
        type: 'stats',
        fps: Math.round((frames * 1000) / (now - second)),
        width: surface.width,
        height: surface.height,
        info: shown?.info ?? '',
      });
      second = now;
      frames = 0;
    }
  }
}

async function shutdown(): Promise<void> {
  hideScene();
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
          post({ type: 'error', message: errorText(error) });
        })
        .then(shutdown)
        .finally(() => process.exit(0));
      break;
    case 'connect':
      if (ports[0]) connect(ports[0]);
      break;
    case 'visible':
      windowVisible = message.visible;
      break;
    case 'quit':
      running = false;
      if (!started) process.exit(0);
      break;
  }
});
