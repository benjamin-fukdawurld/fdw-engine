import { createCoast } from '@fdw/demo-scenes';
import { WebInputSource } from '@fdw/engine-input-web';
import { createRapierPhysics } from '@fdw/engine-physics-rapier';
import type { Example } from './runtime';

// A coast, the sea of an ocean spectrum, and what floats on it: crates and
// a rowing boat carried by the waves, on Rapier. The scene is in
// @fdw/demo-scenes (sea/coast.ts); the canvas receives the keyboard and the
// mouse once clicked: drag to turn around, the wheel to zoom, WASD to
// move, G to switch the waves, Space to drop a crate, R to start again.
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
  const coast = createCoast(physics)(backend, surface, {
    input: new WebInputSource(canvas),
    info,
  });
  onFrame((time) => coast.frame(time));
};

export default example;
