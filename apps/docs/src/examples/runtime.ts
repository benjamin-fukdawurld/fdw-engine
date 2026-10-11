// The runtime of the live examples: one engine per page (WebGPU where the
// browser has it, else WebGL2; ?backend=webgl2 forces it), a surface per
// canvas, a frame loop running while the canvas is visible. For the
// reference images of the CI, ?time=<seconds> stops the clock at that time,
// and ?frames=<count> stops rendering after that many frames; the canvas
// counts its frames in data-frames.
import type { Engine, RenderBackend, Surface } from '@fdw/engine-backend';
import { WebGl2CanvasSurface, WebGl2Engine } from '@fdw/engine-webgl2';
import { WebGpuEngine, WebGpuSurface } from '@fdw/engine-webgpu';

/** What an example receives: a backend, a surface, a frame loop. */
export interface ExampleContext {
  readonly backend: RenderBackend;
  readonly surface: Surface;
  // The canvas: focusable, for the examples that read the keyboard.
  readonly canvas: HTMLCanvasElement;
  // 'WebGPU' or 'WebGL2'.
  readonly backendName: string;
  // Calls `frame` on every animation frame while the example is visible,
  // with the time in seconds since its start.
  onFrame(frame: (time: number) => void): void;
  // Shows a line of information under the canvas, after the backend.
  info(text: string): void;
}

/** An example: sets up its scene, then renders it in onFrame. */
export type Example = (context: ExampleContext) => void | Promise<void>;

let engine: Promise<{ engine: Engine; name: string }> | undefined;

// The engine of the page, created on first use.
function pageEngine(): Promise<{ engine: Engine; name: string }> {
  engine ??= (async () => {
    const forced = new URLSearchParams(window.location.search).get('backend');
    if (forced !== 'webgl2' && 'gpu' in navigator) {
      try {
        const webgpu = new WebGpuEngine();
        await webgpu.init();
        return { engine: webgpu, name: 'WebGPU' };
      } catch {
        // No adapter: WebGL2.
      }
    }
    const webgl2 = new WebGl2Engine();
    await webgl2.init();
    return { engine: webgl2, name: 'WebGL2' };
  })();
  return engine;
}

/** Runs an example in a canvas; reports its backend or error in `status`. */
export async function startExample(
  canvas: HTMLCanvasElement,
  status: HTMLElement,
  example: Example
): Promise<void> {
  try {
    const { engine, name } = await pageEngine();
    const backend = engine.backend;
    if (!backend) {
      throw new Error('The engine is not ready');
    }
    // The canvas has the size of its box, in pixels.
    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio, 2);
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * ratio));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    };
    resize();
    new ResizeObserver(resize).observe(canvas);
    const surface =
      engine instanceof WebGl2Engine
        ? new WebGl2CanvasSurface(canvas)
        : new WebGpuSurface(canvas);
    await surface.init(engine);

    const frames: ((time: number) => void)[] = [];
    status.textContent = name;
    await example({
      backend,
      surface,
      canvas,
      backendName: name,
      onFrame: (frame) => frames.push(frame),
      info: (text) => {
        status.textContent = `${name} · ${text}`;
      },
    });

    // Only while visible: a page can hold many examples.
    let visible = false;
    new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
    }).observe(canvas);
    const start = performance.now();
    const params = new URLSearchParams(window.location.search);
    const fixed = params.get('time');
    const last = Number(params.get('frames') ?? Infinity);
    let count = 0;
    const loop = () => {
      if (visible && count < last) {
        const time =
          fixed !== null ? Number(fixed) : (performance.now() - start) / 1000;
        for (const frame of frames) {
          frame(time);
        }
        canvas.dataset['frames'] = String(++count);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  } catch (error) {
    status.textContent = String((error as Error).message ?? error);
    status.dataset['error'] = '';
    throw error;
  }
}
