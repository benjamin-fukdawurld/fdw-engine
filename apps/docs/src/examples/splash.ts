import { createSplash } from '@fdw/demo-scenes';
import { WebInputSource } from '@fdw/engine-input-web';
import { createRapierPhysics } from '@fdw/engine-physics-rapier';
import type { Example } from './runtime';

// A tank of water made of particles on the GPU: a dam breaks, crates
// dropped in it float, on Rapier. The scene is in @fdw/demo-scenes
// (fluids/splash.ts); the canvas receives the keyboard and the mouse once
// clicked: drag to turn around, the wheel to zoom, Space to drop a crate,
// P to pour water in, R to break the dam again.
const example: Example = async ({
  backend,
  surface,
  canvas,
  onFrame,
  info,
}) => {
  canvas.addEventListener('keydown', (event) => {
    if (event.code.startsWith('Arrow') || event.code === 'Space') {
      event.preventDefault();
    }
  });
  canvas.addEventListener('pointerdown', () => canvas.focus());
  const physics = await createRapierPhysics();
  // Fewer particles where the compute is emulated (WebGL2).
  const emulated = backend.capabilities?.emulatedCompute;
  const splash = createSplash(
    physics,
    emulated ? { count: 4096, radius: 0.03 } : {},
  )(backend, surface, { input: new WebInputSource(canvas), info });
  // Steps of 1/60 s when the clock is stopped (the reference images).
  let last = 0;
  let clock = 0;
  onFrame((time) => {
    clock += time > last ? time - last : 1 / 60;
    last = time;
    splash.frame(clock);
  });
};

export default example;
