import type { Scene, SceneFactory } from '@fdw/demo-scenes';
import { installAssets, type ImageCodec } from '@fdw/engine-assets';
import type { AudioEngine } from '@fdw/engine-audio';
import type { RenderBackend, Surface } from '@fdw/engine-backend';
import { installGltf, installGltfScenes } from '@fdw/engine-gltf';
import type { GamepadState, InputSource } from '@fdw/engine-input';
import { MemorySource, ResourceStore } from '@fdw/engine-resources';
import { installSceneIo } from '@fdw/engine-scene-io';
import {
  levelScene,
  type EngineMessage,
  type GizmoSettings,
  type PageMessage,
  type ViewportBounds,
  type ViewportTool,
} from '../protocol';
import { LevelDocument, type LevelFiles } from './level/LevelDocument';
import { LevelView } from './level/LevelView';
import { RemoteInputSource } from './RemoteInputSource';

/** The view of the engine in the page: a child window, a canvas. */
export interface EngineViewport {
  readonly bounds: ViewportBounds;
  /** The bounds of the area of the page, in device pixels. */
  setBounds(bounds: ViewportBounds): void;
  /**
   * The parts of the page over the viewport, in device pixels in the
   * window: left out by a window over the page (Electron).
   */
  setHoles?(holes: readonly ViewportBounds[]): void;
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
  /**
   * The CPU time used by the process so far, in milliseconds, where the
   * frames wait for the display inside the scene (a swapchain acquiring
   * its image): the duration of a frame would count the wait. Otherwise
   * the statistics count the duration of the frames.
   */
  cpuTime?(): number;
  readonly scenes: Readonly<Record<string, () => Promise<SceneFactory>>>;
  /** The decoders of the images of the levels opened (glTF). */
  readonly imageCodecs?: readonly ImageCodec[];
  readonly audio?: AudioEngine;
  /**
   * The inputs of the scenes when the engine runs in the page (a
   * WebInputSource on the viewport); otherwise those the page sends,
   * replayed (RemoteInputSource).
   */
  readonly input?: InputSource;
  /** The parts of the plugins that run with the engine. */
  readonly extensions?: readonly EngineExtensionFactory[];
}

/** What the engine gives the part of a plugin that runs with it. */
export interface EngineExtensionContext {
  readonly backend: RenderBackend;
  /** Sends a message to the plugin, in the page; `data`: bytes. */
  post(message: unknown, data?: Uint8Array<ArrayBuffer>): void;
}

/**
 * The part of a plugin that runs with the engine (design/editor-ui.md §8,
 * P19): it receives the messages the plugin sends it (`extension`
 * messages, by its id), sees the scene shown, works before each frame.
 */
export interface EngineExtension {
  /** A message of the plugin. */
  receive?(message: unknown, data?: Uint8Array<ArrayBuffer>): void;
  /** The scene shown, once made; undefined when it goes. */
  scene?(scene: Scene | undefined, name: string | undefined): void;
  /** Before each frame, at a time in seconds (the clock of the engine). */
  frame?(time: number): void;
  /**
   * Whether the scene waits (a debugger stopped its game): its frames are
   * not drawn meanwhile.
   */
  readonly holdsScene?: boolean;
  /** The engine ends. */
  dispose?(): void;
}

/** A part of a plugin for the engine: made once the engine has its backend. */
export interface EngineExtensionFactory {
  /** The id its messages are sent under: that of its plugin. */
  readonly id: string;
  create(context: EngineExtensionContext): EngineExtension;
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

/** Where the files of the levels opened are, in the store of the levels. */
export const levelScheme = 'level';

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
 *
 * It holds the level being edited (LevelDocument), shown as the scene
 * `level` (LevelView): the page opens, saves and changes it by messages,
 * and gets its projection back.
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
  #levelFiles?: LevelFiles;
  #document?: LevelDocument;
  #view?: LevelView;
  // The tool and the gizmo of the page, for the views to come.
  #tool: ViewportTool = 'select';
  #gizmo: GizmoSettings = { space: 'world', pivot: 'center', snapping: false };
  // The level files opened or saved one after the other.
  #levelQueue: Promise<void> = Promise.resolve();
  readonly #extensions = new Map<string, EngineExtension>();

  constructor(platform: EditorEnginePlatform, scene: string) {
    this.#platform = platform;
    this.#requested = scene;
    for (const factory of platform.extensions ?? []) {
      const { id } = factory;
      this.#extensions.set(
        id,
        factory.create({
          backend: platform.backend,
          post: (message, data) =>
            this.#post({
              type: 'extension',
              extension: id,
              message,
              ...(data && { data }),
            }),
        }),
      );
    }
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
      scenes: [levelScene, ...Object.keys(this.#platform.scenes)],
      scene: this.#requested,
    });
    this.#level().connect(this.#postLevel);
  }

  /** A message of the page. */
  receive(message: PageMessage): void {
    switch (message.type) {
      case 'bounds':
        this.#platform.viewport.setBounds(message);
        break;
      case 'holes':
        this.#platform.viewport.setHoles?.(message.holes);
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
      case 'level.new':
        this.#queueLevel(async () =>
          this.#replaceLevel(LevelDocument.create(this.#files())),
        );
        break;
      case 'level.open': {
        const { name, data } = message;
        this.#queueLevel(async () =>
          this.#replaceLevel(
            await LevelDocument.open(this.#files(), name, data, this.#warn),
          ),
        );
        break;
      }
      case 'level.save': {
        const { format, name } = message;
        const document = this.#level();
        this.#queueLevel(async () => {
          const data = await document.save(format, name, this.#warn);
          this.#post({ type: 'level.file', name, format, data });
        });
        break;
      }
      case 'level.saved':
        this.#document?.saved(message.name);
        break;
      case 'level.command':
        if (message.command === 'frame') this.#view?.frameSelection();
        else this.#level().run(message);
        break;
      case 'level.tool':
        this.#tool = message.tool;
        this.#view?.setTool(message.tool);
        break;
      case 'level.gizmo': {
        const { space, pivot, snapping } = message;
        const gizmo = { space, pivot, snapping };
        this.#gizmo = gizmo;
        this.#view?.setGizmo(gizmo);
        break;
      }
      case 'extension': {
        const extension = this.#extensions.get(message.extension);
        try {
          extension?.receive?.(message.message, message.data);
        } catch (error) {
          this.#post({
            type: 'error',
            message: `${message.extension}: ${errorText(error)}`,
          });
        }
        break;
      }
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
    // The time spent in the frames of the scene, this second.
    let busy = 0;
    while (this.#running) {
      platform.viewport.pump?.();
      this.#levelFiles?.store.update();
      const held = this.#runExtensions();
      const shown = this.#shown;
      if (shown && this.#onScreen() && !held) {
        try {
          const begin = performance.now();
          const used = platform.cpuTime?.();
          shown.scene.frame((begin - shown.start) / 1000);
          busy +=
            used === undefined
              ? performance.now() - begin
              : (platform.cpuTime?.() ?? used) - used;
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
          cpu: frames > 0 ? busy / frames : 0,
          gpu:
            this.#shown?.name === levelScene ? this.#view?.gpuTime : undefined,
          width: surface.width,
          height: surface.height,
          info: this.#shown?.info ?? '',
        });
        second = now;
        frames = 0;
        busy = 0;
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
    for (const extension of this.#extensions.values()) extension.dispose?.();
    this.#extensions.clear();
    this.#document?.dispose();
    this.#document = undefined;
    this.#levelFiles?.store.dispose();
  }

  #post(message: EngineMessage): void {
    this.#channel?.post(message);
  }

  // The work of the extensions before a frame; whether one holds the
  // scene.
  #runExtensions(): boolean {
    let held = false;
    const time = performance.now() / 1000;
    for (const [id, extension] of this.#extensions) {
      try {
        extension.frame?.(time);
        held ||= extension.holdsScene === true;
      } catch (error) {
        this.#post({ type: 'error', message: `${id}: ${errorText(error)}` });
      }
    }
    return held;
  }

  // Tells the extensions the scene shown.
  #sceneChanged(scene: Scene | undefined, name: string | undefined): void {
    for (const [id, extension] of this.#extensions) {
      try {
        extension.scene?.(scene, name);
      } catch (error) {
        this.#post({ type: 'error', message: `${id}: ${errorText(error)}` });
      }
    }
  }

  // To the channel of the moment: the page may reconnect.
  readonly #postLevel = (message: EngineMessage) => this.#post(message);

  // What the level could not read or write, in the console of the page.
  readonly #warn = (text: string) =>
    this.#post({ type: 'log', level: 'error', text });

  // The store of the levels: the files opened in memory, the loaders of
  // the scenes of the engine and of glTF.
  #files(): LevelFiles {
    if (!this.#levelFiles) {
      const store = new ResourceStore();
      installAssets(store, {
        backend: this.#platform.backend,
        codecs: [...(this.#platform.imageCodecs ?? [])],
      });
      installGltf(store);
      installGltfScenes(store);
      installSceneIo(store);
      const source = new MemorySource();
      store.mount(levelScheme, source);
      this.#levelFiles = { store, source, scheme: levelScheme };
    }
    return this.#levelFiles;
  }

  // The level edited: the sample one until another is opened.
  #level(): LevelDocument {
    this.#document ??= LevelDocument.create(this.#files());
    return this.#document;
  }

  // One after the other: a level saved is the one of the moment.
  #queueLevel(task: () => Promise<void>): void {
    this.#levelQueue = this.#levelQueue.then(task).catch((error: unknown) => {
      this.#post({ type: 'error', message: `Level: ${errorText(error)}` });
    });
  }

  // Another level: shown in the viewport, the previous one destroyed after
  // its view.
  #replaceLevel(document: LevelDocument): void {
    const previous = this.#document;
    this.#document = document;
    document.connect(this.#postLevel);
    this.#requested = levelScene;
    if (this.#shown?.name === levelScene) this.#hideScene();
    if (this.#surface && this.#running) void this.#showScene(levelScene);
    previous?.dispose();
  }

  // The scene of a name: the level, or one of the platform.
  async #factory(name: string): Promise<SceneFactory | undefined> {
    if (name !== levelScene) return this.#platform.scenes[name]?.();
    return (backend, surface, context) => {
      const view = new LevelView(this.#level(), {
        backend,
        surface,
        input: context?.input as InputSource,
        post: this.#postLevel,
        tool: this.#tool,
        gizmo: this.#gizmo,
      });
      this.#view = view;
      return {
        // The materials of the level, for the editors of graphs.
        get graphs() {
          return view.graphs;
        },
        frame: (time) => view.frame(time),
        destroy: () => {
          if (this.#view === view) this.#view = undefined;
          view.destroy();
        },
      };
    };
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
    this.#sceneChanged(undefined, undefined);
    shown.scene.destroy();
    this.#shown = undefined;
    // A lock taken by the scene is released.
    shown.input.setPointerLock?.(false);
  }

  async #showScene(name: string): Promise<void> {
    const request = ++this.#requests;
    if (name !== levelScene && !this.#platform.scenes[name]) {
      this.#post({ type: 'error', message: `No scene named ${name}` });
      return;
    }
    this.#post({ type: 'loading', scene: name });
    try {
      const factory = await this.#factory(name);
      const surface = this.#surface;
      if (request !== this.#requests || !this.#running || !surface || !factory)
        return;
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
      this.#sceneChanged(scene, name);
    } catch (error) {
      this.#post({ type: 'error', message: `${name}: ${errorText(error)}` });
    }
  }
}
