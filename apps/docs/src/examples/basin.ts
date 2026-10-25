import { createBasin } from '@fdw/demo-scenes';
import { WebInputSource } from '@fdw/engine-input-web';
import { createRapierPhysics } from '@fdw/engine-physics-rapier';
import type { Example } from './runtime';

// A pond in a valley, its water a field of heights on the GPU, fed by a
// stream from a spring on a hill; crates and balls float on it, on Rapier.
// The scene is in @fdw/demo-scenes (fluids/basin.ts); the canvas receives
// the keyboard and the mouse once clicked: drag to turn around, the wheel
// to zoom, WASD to move, Space to drop a crate, B a ball, E a splash, F to
// stop the spring, R to start again.
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
  const basin = createBasin(physics, {
    resolution: backend.capabilities?.emulatedCompute ? 96 : 128,
  })(backend, surface, { input: new WebInputSource(canvas), info });
  // Steps of 1/60 s when the clock is stopped (the reference images).
  let last = 0;
  let clock = 0;
  onFrame((time) => {
    clock += time > last ? time - last : 1 / 60;
    last = time;
    basin.frame(clock);
  });
};

export default example;
