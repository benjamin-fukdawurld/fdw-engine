import { Engine, EngineState } from '@fdw/engine-backend';
import { signal, Signal } from '@preact/signals-core';
import { WebGl2RenderBackend } from './render/WebGl2RenderBackend';

export type WebGl2EngineOptions = {
  // The canvas holding the WebGL2 context. Defaults to an offscreen canvas
  // owned by the engine; each surface then presents its frames to its own
  // canvas. Giving the visible canvas saves a copy per frame when there is a
  // single one.
  canvas?: HTMLCanvasElement | OffscreenCanvas;
  contextAttributes?: WebGLContextAttributes;
};

// A WebGL2 context is tied to a canvas, where WebGPU devices are not: the
// engine owns the context, and the surfaces render to framebuffers of their
// own (with the depth buffer of the renderer), copied to their canvas when
// presented.
export class WebGl2Engine extends EventTarget implements Engine {
  canvas?: HTMLCanvasElement | OffscreenCanvas;
  gl?: WebGL2RenderingContext;
  backend: WebGl2RenderBackend | undefined = undefined;
  state: Signal<EngineState> = signal('uninitialized');

  private readonly _options: WebGl2EngineOptions;

  constructor(options: WebGl2EngineOptions = {}) {
    super();
    this._options = options;
  }

  async init(): Promise<void> {
    if (
      this.state.value !== 'uninitialized' &&
      this.state.value !== 'destroyed'
    ) {
      throw new Error(
        `Cannot initialize an engine in the ${this.state.value} state`
      );
    }
    this.state.value = 'initializing';

    try {
      const canvas =
        this._options.canvas ??
        (typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(1, 1)
          : undefined);
      if (!canvas) {
        throw new Error('WebGL2 needs a canvas or OffscreenCanvas');
      }
      const gl = canvas.getContext('webgl2', {
        // The depth buffers belong to the renderer, multisampling is not
        // supported yet: the drawing buffer is only a presentation image.
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: true,
        ...this._options.contextAttributes,
      }) as WebGL2RenderingContext | null;
      if (!gl) {
        throw new Error('WebGL2 is not supported in this environment');
      }
      this.canvas = canvas;
      this.gl = gl;
      this.backend = new WebGl2RenderBackend(gl);
    } catch (error) {
      this.canvas = undefined;
      this.gl = undefined;
      this.state.value = 'uninitialized';
      throw error;
    }

    this.state.value = 'ready';
    this.dispatchEvent(
      new CustomEvent<WebGl2Engine>('ready', { detail: this })
    );
  }

  async pause(): Promise<void> {
    if (this.state.value !== 'ready') {
      throw new Error('Engine must be in ready state to pause');
    }
    this.state.value = 'paused';
    this.dispatchEvent(
      new CustomEvent<WebGl2Engine>('paused', { detail: this })
    );
  }

  async resume(): Promise<void> {
    if (this.state.value !== 'paused') {
      throw new Error('Engine must be in paused state to resume');
    }
    this.state.value = 'ready';
    this.dispatchEvent(
      new CustomEvent<WebGl2Engine>('resumed', { detail: this })
    );
  }

  async destroy(): Promise<void> {
    this.state.value = 'destroying';
    this.gl?.getExtension('WEBGL_lose_context')?.loseContext();
    this.gl = undefined;
    this.canvas = undefined;
    this.backend = undefined;

    this.state.value = 'destroyed';
    this.dispatchEvent(
      new CustomEvent<WebGl2Engine>('destroyed', { detail: this })
    );
  }
}

export default WebGl2Engine;
