import type { RenderBackend } from '@fdw/engine-backend';
import { WebGpuEngine, WebGpuOffscreenSurface } from '@fdw/engine-webgpu';
import { RenderingFixture, size } from './suite';

// Dawn (the WebGPU implementation of Chrome) in Node; undefined where it
// cannot load.
export const dawn = await import('webgpu').catch(() => undefined);

/**
 * A rendering fixture on Dawn: an engine and an offscreen surface of the
 * size of the suite. `inspect` can wrap the backend (to record what the
 * suite creates).
 */
export async function createDawnFixture(
  inspect?: (backend: RenderBackend) => void,
): Promise<RenderingFixture & { engine: WebGpuEngine }> {
  if (!dawn) {
    throw new Error('Dawn is not available');
  }
  Object.assign(globalThis, dawn.globals);
  const engine = new WebGpuEngine({ gpu: dawn.create([]) });
  await engine.init();
  const backend = engine.backend as RenderBackend;
  inspect?.(backend);
  const surface = new WebGpuOffscreenSurface(size, size);
  await surface.init(engine);
  return {
    engine,
    backend,
    surface,
    readPixels: () => surface.readPixels(),
    destroy: async () => {
      surface.destroy();
      await engine.destroy();
    },
  };
}
