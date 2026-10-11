import { createMazeStep1 } from '@fdw/demo-scenes';
import type { Example } from './runtime';

// Step 1 of the maze game, in the page: the canvas receives the keyboard
// and the wheel once clicked.
const example: Example = ({ backend, surface, canvas, onFrame, info }) => {
  // The keys and the wheel move the camera, not the page.
  const keys = new Set([
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    ' ',
  ]);
  canvas.addEventListener('keydown', (event) => {
    if (keys.has(event.key)) {
      event.preventDefault();
    }
  });
  canvas.addEventListener('wheel', (event) => event.preventDefault(), {
    passive: false,
  });
  canvas.addEventListener('pointerdown', () => canvas.focus());

  const game = createMazeStep1(backend, surface, {
    input: canvas,
    info: (text) => info(`${text} · click, then WASD, Q/E, wheel`),
  });
  onFrame((time) => game.frame(time));
};

export default example;
