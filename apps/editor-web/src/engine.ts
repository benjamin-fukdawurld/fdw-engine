import type { SceneFactory } from '@fdw/demo-scenes';
import type { EngineConnection } from '@fdw/editor-ui';
import {
  EditorEngine,
  startBackend,
  type EngineChannel,
  type EngineViewport,
} from '@fdw/editor-ui/engine';
import type {
  EngineMessage,
  PageMessage,
  ViewportBounds,
} from '@fdw/editor-ui/protocol';
import { bitmapCodec } from '@fdw/engine-assets';
import { graphsExtension } from '@fdw/graph-editor/engine';
import { unlockAudio, WebAudioEngine } from '@fdw/engine-audio-web';
import { WebInputSource } from '@fdw/engine-input-web';
import { createImageBitmapDecoder } from '@fdw/engine-resources-web';
import { startWebGl2, startWebGpu, type Renderer } from './backends';

export interface WebEngineOptions {
  /** A value of FDW_BACKEND: webgpu (by default), webgl2. */
  readonly backend?: string;
  /** The scene shown first. */
  readonly scene: string;
  readonly scenes: Readonly<Record<string, () => Promise<SceneFactory>>>;
}

type Listener = (message: EngineMessage) => void;

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const animationFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

// The viewport of the engine: the canvas of the backend, sized to the area
// of the page in device pixels.
function canvasViewport(canvas: HTMLCanvasElement): EngineViewport {
  let bounds: ViewportBounds = { x: 0, y: 0, width: 0, height: 0 };
  return {
    get bounds() {
      return bounds;
    },
    setBounds(next) {
      bounds = next;
      if (next.width > 0 && next.height > 0) {
        canvas.width = next.width;
        canvas.height = next.height;
      }
    },
  };
}

/**
 * The engine of the web editor, in the page: the EditorEngine of
 * @fdw/editor-ui behind a MessageChannel, the same protocol as the engine
 * process of Electron, so that the shell never holds it (it may go into a
 * worker). The backend draws into a canvas of its own, placed in the
 * element of the viewport; the scenes read the inputs on that element.
 */
export class WebEngine {
  /** The page side of the channel. */
  readonly connection: EngineConnection;
  /** Where the viewport shows the engine: its canvas, its inputs. */
  readonly element: HTMLElement;
  readonly #port: MessagePort;
  readonly #running: Promise<void>;
  #editor?: EditorEngine;
  #stopped = false;

  constructor(options: WebEngineOptions) {
    const channel = new MessageChannel();
    const listeners = new Set<Listener>();
    // The messages of the page wait in the channel until the engine runs,
    // those of the engine until the shell listens (the ready message of
    // WebGL2 would come before).
    const page = channel.port1;
    this.connection = {
      post: (message) => page.postMessage(message),
      subscribe: (listener) => {
        listeners.add(listener);
        page.onmessage ??= ({ data }) =>
          listeners.forEach((listener) => listener(data as EngineMessage));
        return () => listeners.delete(listener);
      },
    };
    this.#port = channel.port2;
    const element = document.createElement('div');
    // Focusable, to receive the keys once clicked.
    element.tabIndex = 0;
    element.style.width = '100%';
    element.style.height = '100%';
    element.style.outline = 'none';
    this.element = element;
    this.#running = this.#run(options);
  }

  /** Ends the frames, then destroys the scene and the backend. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#editor?.stop();
    await this.#running;
  }

  async #run(options: WebEngineOptions): Promise<void> {
    const port = this.#port;
    const channel: EngineChannel = {
      post: (message) => port.postMessage(message),
      close: () => port.close(),
    };
    let renderer: Renderer | undefined;
    let audio: WebAudioEngine | undefined;
    let lockAudio: (() => void) | undefined;
    try {
      const backend = await startBackend(
        options.backend,
        { name: 'webgpu', start: startWebGpu },
        { name: 'webgl2', start: startWebGl2 },
      );
      renderer = backend.value;
      if (backend.fallback) {
        console.warn(
          `[engine] Fallback to ${backend.name}: ${backend.fallback}`,
        );
      }
      this.element.append(renderer.canvas);
      audio = new WebAudioEngine();
      // The browser starts the audio at a gesture only.
      lockAudio = unlockAudio(audio);
      const { surface } = renderer;
      const editor = new EditorEngine(
        {
          backend: renderer.backend,
          backendName: backend.name,
          fallback: backend.fallback,
          device: renderer.device,
          viewport: canvasViewport(renderer.canvas),
          createSurface: async () => surface,
          // WebGPU and WebGL2 keep the resources of the frames in flight.
          waitIdle: () => undefined,
          nextFrame: animationFrame,
          scenes: options.scenes,
          imageCodecs: [bitmapCodec(createImageBitmapDecoder())],
          audio,
          input: new WebInputSource(this.element),
          // The part of the editors of graphs in the engine.
          extensions: [graphsExtension()],
        },
        options.scene,
      );
      this.#editor = editor;
      editor.connect(channel);
      port.onmessage = ({ data }) => editor.receive(data as PageMessage);
      if (!this.#stopped) await editor.run();
    } catch (error) {
      console.error('[engine]', error);
      channel.post({ type: 'error', message: errorText(error) });
    }
    this.#editor?.destroy();
    lockAudio?.();
    audio?.destroy();
    renderer?.canvas.remove();
    await renderer?.destroy();
    port.close();
  }
}
