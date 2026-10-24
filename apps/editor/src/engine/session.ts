import type { StartedBackend } from '@fdw/editor-ui/engine';
import { EditorEngine, type EngineChannel } from '@fdw/editor-ui/engine';
import {
  levelScene,
  type EngineMessage,
  type PageMessage,
} from '@fdw/editor-ui/protocol';
import { pixelCodec } from '@fdw/engine-assets';
import { NativeAudioEngine } from '@fdw/engine-audio-native';
import { createStbImageDecoder } from '@fdw/engine-resources-native';
import type { Renderer } from './backends';
import { scenes } from './scenes';
import type { X11Viewport } from './viewport';

// The scene shown first: the level (FDW_SCENE chooses another).
const defaultScene = process.env['FDW_SCENE'] ?? levelScene;

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * A page connected to the engine: a MessagePort in the engine process, the
 * IPC of the Dawn process. Its messages wait until listen().
 */
export interface PageLink extends EngineChannel {
  listen(receive: (message: PageMessage) => void): void;
}

/**
 * The EditorEngine of a process, the same in the engine process (Vulkan)
 * and in the Dawn process: the page it talks to (one per page load), the
 * visibility of the window, the stop; the engine destroyed after its last
 * frame, before the window goes.
 */
export class EngineSession {
  #page?: PageLink;
  #editor?: EditorEngine;
  #visible = true;
  #stopped = false;

  /** A new page; the previous one is closed. */
  connect(page: PageLink): void {
    if (!this.#editor) {
      this.#page?.close();
      this.#page = page;
      return;
    }
    const editor = this.#editor;
    this.#page = page;
    editor.connect(page);
    page.listen((message) => editor.receive(message));
  }

  /** No frames while the window is minimized or hidden. */
  setVisible(visible: boolean): void {
    this.#visible = visible;
    this.#editor?.setVisible(visible);
  }

  /** Ends run() after the frame in progress. */
  stop(): void {
    this.#stopped = true;
    this.#editor?.stop();
  }

  /**
   * Starts the backend on the viewport and draws the frames until stop();
   * an error is told to the page. Everything is destroyed when it resolves,
   * the viewport last.
   */
  async run(
    viewport: X11Viewport,
    start: () => Promise<StartedBackend<Renderer>>,
  ): Promise<void> {
    let renderer: Renderer | undefined;
    let audio: NativeAudioEngine | undefined;
    try {
      const backend = await start();
      renderer = backend.value;
      if (backend.fallback) {
        console.warn(
          `[engine] Fallback to ${backend.name}: ${backend.fallback}`,
        );
      }
      try {
        audio = new NativeAudioEngine();
      } catch (error) {
        console.warn(`[engine] No audio: ${errorText(error)}`);
      }
      const editor = new EditorEngine(
        {
          backend: backend.value.backend,
          backendName: backend.name,
          fallback: backend.fallback,
          device: backend.value.device,
          viewport,
          createSurface: async () => backend.value.surface,
          waitIdle: () => backend.value.waitIdle(),
          nextFrame: () => backend.value.nextFrame(),
          // The swapchain waits for the display in the frame.
          cpuTime: () => {
            const { user, system } = process.cpuUsage();
            return (user + system) / 1000;
          },
          scenes,
          imageCodecs: [pixelCodec(createStbImageDecoder())],
          audio,
        },
        defaultScene,
      );
      this.#editor = editor;
      editor.setVisible(this.#visible);
      if (this.#page) this.connect(this.#page);
      if (!this.#stopped) await editor.run();
    } catch (error) {
      console.error('[engine]', error);
      this.report(errorText(error));
    }
    this.#editor?.destroy();
    audio?.destroy();
    await renderer?.destroy();
    viewport.destroy();
  }

  /** An error the page shows in its status bar. */
  report(message: string): void {
    this.#page?.post({ type: 'error', message } satisfies EngineMessage);
  }
}
