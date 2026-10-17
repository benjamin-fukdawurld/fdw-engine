import { createFpsScene } from '@fdw/demo-scenes';
import { unlockAudio, WebAudioEngine } from '@fdw/engine-audio-web';
import { WebInputSource } from '@fdw/engine-input-web';
import type { Example } from './runtime';

// The first person shooter, in the page: the canvas receives the keyboard
// and the mouse once clicked, and locks the pointer; the sound starts at
// the first click.
const example: Example = ({ backend, surface, canvas, onFrame, info }) => {
  // The keys and the right button drive the game, not the page.
  canvas.addEventListener('keydown', (event) => {
    if (event.code.startsWith('Arrow') || event.code === 'Space') {
      event.preventDefault();
    }
  });
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  canvas.addEventListener('pointerdown', () => canvas.focus());

  const audio = new WebAudioEngine();
  unlockAudio(audio, canvas);
  const game = createFpsScene(backend, surface, {
    input: new WebInputSource(canvas),
    audio,
    info,
  });
  onFrame((time) => game.frame(time));
};

export default example;
