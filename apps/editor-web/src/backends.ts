import type { Engine, RenderBackend, Surface } from '@fdw/engine-backend';
import { WebGl2CanvasSurface, WebGl2Engine } from '@fdw/engine-webgl2';
import { WebGpuEngine, WebGpuSurface } from '@fdw/engine-webgpu';

/** A backend started on a canvas of its own, with its surface. */
export interface Renderer {
  readonly backend: RenderBackend;
  readonly device: string;
  /** Placed in the viewport once started. */
  readonly canvas: HTMLCanvasElement;
  readonly surface: Surface;
  /** After the scene: the engine. */
  destroy(): Promise<void>;
}

// A canvas per backend: one that got a WebGPU context can no longer give a
// WebGL2 one, the fallback.
function createCanvas(): HTMLCanvasElement {
  // Sized by the bounds of the viewport (CanvasViewport), in device pixels;
  // its default size until then (a context on an empty canvas warns).
  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  return canvas;
}

// Destroys the engine when its surface cannot be made.
async function startOrClean<T>(engine: Engine, start: () => Promise<T>) {
  try {
    await engine.init();
    return await start();
  } catch (error) {
    await engine.destroy().catch(() => undefined);
    throw error;
  }
}

/**
 * WebGPU, the preferred backend: no `navigator.gpu`, no adapter or no
 * device mean the fallback.
 */
export async function startWebGpu(): Promise<Renderer> {
  const engine = new WebGpuEngine();
  return startOrClean(engine, async () => {
    const { backend, adapter } = engine;
    if (!backend || !adapter) throw new Error('The WebGPU engine is not ready');
    const canvas = createCanvas();
    const surface = new WebGpuSurface(canvas, { alphaMode: 'opaque' });
    await surface.init(engine);
    const { description, vendor, architecture } = adapter.info;
    return {
      backend,
      device: description || [vendor, architecture].join(' ').trim() || 'GPU',
      canvas,
      surface,
      destroy: () => engine.destroy(),
    };
  });
}

/**
 * WebGL2, the fallback: its context on the canvas of the viewport, which
 * saves a copy per frame.
 */
export async function startWebGl2(): Promise<Renderer> {
  const canvas = createCanvas();
  const engine = new WebGl2Engine({ canvas });
  return startOrClean(engine, async () => {
    const { backend, gl } = engine;
    if (!backend || !gl) throw new Error('The WebGL2 engine is not ready');
    const surface = new WebGl2CanvasSurface(canvas);
    await surface.init(engine);
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const device = debug
      ? (gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) as string)
      : (gl.getParameter(gl.RENDERER) as string);
    return {
      backend,
      device,
      canvas,
      surface,
      destroy: async () => {
        surface.destroy();
        await engine.destroy();
      },
    };
  });
}
