import { createTpsScene } from '@fdw/demo-scenes';
import { bitmapCodec, installAssets } from '@fdw/engine-assets';
import { unlockAudio, WebAudioEngine } from '@fdw/engine-audio-web';
import { installGltf } from '@fdw/engine-gltf';
import { WebInputSource } from '@fdw/engine-input-web';
import { createRapierPhysics } from '@fdw/engine-physics-rapier';
import { HttpSource, ResourceStore } from '@fdw/engine-resources';
import { createImageBitmapDecoder } from '@fdw/engine-resources-web';
import type { Example } from './runtime';

// The third-person game, in the page: the models of public/models/forest,
// Rapier for the physics; the canvas receives the keyboard and the mouse
// once clicked, and locks the pointer; the sound starts at the first click.
const example: Example = async ({
  backend,
  surface,
  canvas,
  onFrame,
  info,
}) => {
  // The keys and the buttons drive the game, not the page.
  canvas.addEventListener('keydown', (event) => {
    if (event.code.startsWith('Arrow') || event.code === 'Space') {
      event.preventDefault();
    }
  });
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  canvas.addEventListener('pointerdown', () => canvas.focus());

  const resources = new ResourceStore();
  resources.mount('http', new HttpSource({ base: '/fdw-engine/models/' }), {
    default: true,
  });
  installAssets(resources, {
    codecs: [bitmapCodec(createImageBitmapDecoder())],
  });
  installGltf(resources);
  const physics = await createRapierPhysics();

  const audio = new WebAudioEngine();
  unlockAudio(audio, canvas);
  const game = createTpsScene({ physics, resources: () => resources })(
    backend,
    surface,
    { input: new WebInputSource(canvas), audio, info },
  );
  // The models and the forest, before the first frame.
  const loading = setInterval(() => game.frame(0), 50);
  await game.ready;
  clearInterval(loading);
  onFrame((time) => game.frame(time));
};

export default example;
