import { WebGl2Engine, WebGl2OffscreenSurface } from '@fdw/engine-webgl2';
import { describeRenderer, size } from './suite';

// The shared rendering tests on WebGL2, in headless Chromium.
describeRenderer('Renderer on WebGL2', async () => {
  const engine = new WebGl2Engine();
  await engine.init();
  const surface = new WebGl2OffscreenSurface(size, size);
  await surface.init(engine);
  return {
    backend: engine.backend!,
    surface,
    readPixels: () => surface.readPixels(),
    destroy: async () => {
      surface.destroy();
      await engine.destroy();
    },
  };
});
