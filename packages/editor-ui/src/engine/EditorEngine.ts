import type { Scene, SceneFactory } from '@fdw/demo-scenes';
import type { AudioEngine } from '@fdw/engine-audio';
import type { RenderBackend, Surface } from '@fdw/engine-backend';
import type { GamepadState, InputSource } from '@fdw/engine-input';
import type { EngineMessage, PageMessage, ViewportBounds } from '../protocol';
import { RemoteInputSource } from './RemoteInputSource';

/** The view of the engine in the page: a child window, a canvas. */
export interface EngineViewport {
  readonly bounds: ViewportBounds;
  /** The bounds of the area of the page, in device pixels. */
  setBounds(bounds: ViewportBounds): void;
  /** Before each frame (the X11 window of Electron kept above Chromium's). */
  pump?(): void;
}

/** What the engine side gets from where it runs: a process, a page. */
export interface EditorEnginePlatform {
  /** The backend of the rendering engine, ready. */
  readonly backend: RenderBackend;
  /** Its name, a value of FDW_BACKEND (startBackend). */
  readonly backendName: string;
  /** Why it is not the backend asked for. */
  readonly fallback?: string;
  /** The name of the device, shown in the status bar. */
  readonly device: string;
  readonly viewport: EngineViewport;
  /** The surface of the viewport, made once it has an area. */
  createSurface(): Promise<Surface>;
  /** Waits for the frames in flight, before the resources of a scene go. */
  waitIdle(): void;
  /** Between two frames: lets the messages, the I/O and the promises run. */
  nextFrame(): Promise<void>;
  readonly scenes: Readonly<Record<string, () => Promise<SceneFactory>>>;
  readonly audio?: AudioEngine;
  /**
   * The inputs of the scenes when the engine runs in the page (a
   * WebInputSource on the viewport); otherwise those the page sends,
   * replayed (RemoteInputSource).
   */
  readonly input?: InputSource;
}

/** Where the messages of the engine go: a MessagePort to the page. */
export interface EngineChannel {
  post(message: EngineMessage): void;
  close(): void;
}

// The scene in the viewport.
interface Shown {
  readonly name: string;
  readonly scene: Scene;
  readonly input: InputSource;
  // The inputs of the page, replayed: without the input of the platform.
  readonly remote?: RemoteInputSource;
  readonly start: number;
  // Set by the scene (SceneContext.info).
  info: string;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * The engine side of the editor, independent of where it runs: the utility
 * process of Electron, the page of the web editor. It receives the messages
 * of the page (bounds, scene, inputs), shows the scenes in the viewport and
 * sends back what it does; the platform gives it the backend, the viewport
 * and the surface. The page may reconnect (a reload): a new channel.
 */
export class EditorEngine {
  readonly #platform: EditorEnginePlatform;
  #channel?: EngineChannel;
  #surface?: Surface;
  #shown?: Shown;
  #running = false;
  // The scene asked for, and the number of the last request: a scene still
  // loading when another is asked for is dropped.
  #requested: string;
  #requests = 0;
  // Whether the window is minimized or hidden.
  #visible = true;
  #gamepads: readonly GamepadState[] = [];

  constructor(platform: EditorEnginePlatform, scene: string) {
    this.#platform = platform;
    this.#requested = scene;
  }

  /** Sends the messages to a new page; the previous channel is closed. */
  connect(channel: EngineChannel): void {
    this.#channel?.close();
    this.#channel = channel;
    const { backendName, fallback } = this.#platform;
    this.#post({
      type: 'ready',
      backend: backendName,
      ...(fallback !== undefined && { fallback }),
      device: this.#platform.device,
      scenes: Object.keys(this.#platform.scenes),
      scene: this.#requested,
    });
  }

  /** A message of the page. */
  receive(message: PageMessage): void {
    switch (message.type) {
      case 'bounds':
        this.#platform.viewport.setBounds(message);
        break;
      case 'scene':
        if (message.name !== this.#requested) {
          this.#requested = message.name;
          if (this.#surface) void this.#showScene(message.name);
        }
        break;
      case 'input':
        this.#shown?.remote?.receive(message);
        break;
      case 'gamepads':
        this.#gamepads = message.states;
        this.#shown?.remote?.setGamepads(message.states);
        break;
    }
  }

  /** No frames while the window is minimized or hidden. */
  setVisible(visible: boolean): void {
    this.#visible = visible;
  }

  /**
   * Draws the frames until stop(): the surface is made once the viewport
   * has an area, the scene asked for shown then. Statistics once a second.
   */
  async run(): Promise<void> {
    const platform = this.#platform;
    this.#running = true;
    // The surface needs a viewport with an area, and the scenes its format.
    while (this.#running && !this.#onScreen()) {
      platform.viewport.pump?.();
      await sleep(16);
    }
    if (!this.#running) return;
    const surface = await platform.createSurface();
    this.#surface = surface;
    void this.#showScene(this.#requested);

    let second = performance.now();
    let frames = 0;
    while (this.#running) {
      platform.viewport.pump?.();
      const shown = this.#shown;
      if (shown && this.#onScreen()) {
        try {
          shown.scene.frame((performance.now() - shown.start) / 1000);
          frames++;
        } catch (error) {
          this.#post({
            type: 'error',
            message: `${shown.name}: ${errorText(error)}`,
          });
          this.#hideScene();
        }
        await platform.nextFrame();
      } else {
        await sleep(16);
      }
      const now = performance.now();
      if (now - second >= 1000) {
        this.#post({
          type: 'stats',
          fps: Math.round((frames * 1000) / (now - second)),
          width: surface.width,
          height: surface.height,
          info: this.#shown?.info ?? '',
        });
        second = now;
        frames = 0;
      }
    }
  }

  /** Ends run() after the frame in progress. */
  stop(): void {
    this.#running = false;
  }

  /** Destroys the scene shown: after run(), before the surface goes. */
  destroy(): void {
    this.#running = false;
    this.#hideScene();
  }

  #post(message: EngineMessage): void {
    this.#channel?.post(message);
  }

  // Whether the viewport is on screen: frames are only drawn then.
  #onScreen(): boolean {
    const { width, height } = this.#platform.viewport.bounds;
    return this.#visible && width > 0 && height > 0;
  }

  #hideScene(): void {
    const shown = this.#shown;
    if (!shown) return;
    // The frames in flight still use its resources.
    this.#platform.waitIdle();
    shown.scene.destroy();
    this.#shown = undefined;
    // A lock taken by the scene is released.
    shown.input.setPointerLock?.(false);
  }

  async #showScene(name: string): Promise<void> {
    const request = ++this.#requests;
    const load = this.#platform.scenes[name];
    if (!load) {
      this.#post({ type: 'error', message: `No scene named ${name}` });
      return;
    }
    this.#post({ type: 'loading', scene: name });
    try {
      const factory = await load();
      const surface = this.#surface;
      if (request !== this.#requests || !this.#running || !surface) return;
      this.#hideScene();
      let input = this.#platform.input;
      let remote: RemoteInputSource | undefined;
      if (!input) {
        remote = new RemoteInputSource((message) => this.#post(message));
        remote.setGamepads(this.#gamepads);
        input = remote;
      }
      const context = { info: '' };
      const scene = factory(this.#platform.backend, surface, {
        input,
        audio: this.#platform.audio,
        info: (text) => {
          context.info = text;
        },
      });
      this.#shown = Object.assign(context, {
        name,
        scene,
        input,
        remote,
        start: performance.now(),
      });
    } catch (error) {
      this.#post({ type: 'error', message: `${name}: ${errorText(error)}` });
    }
  }
}
