import { Camera, Renderer } from '@fdw/engine-core';
import { buildGallery, followAspect, galleryCamera } from '@fdw/demo-scenes';
import type { Example } from './runtime';

// A gallery of procedural materials, computed at each pixel from its
// position, without textures: wood, marble, rock and lava (animated by a
// 4D noise) in front; bricks and tiles (on the uv of cubes) and a rock
// baked once into a texture, read in triplanar mapping, behind. The floor
// is a checkerboard averaged over the pixels: click to see it without the
// filter, flickering in the distance. The graphs of the materials are in
// packages/demo-scenes/src/procedural/materials.ts.
const example: Example = async ({
  backend,
  surface,
  canvas,
  onFrame,
  info,
}) => {
  const renderer = new Renderer(backend, {
    output: { toneMapping: 'neutral', encoding: 'srgb' },
  });
  // Bakes the rock texture first: a 4D cellular noise and a fbm, once.
  const gallery = await buildGallery(renderer);
  const camera = new Camera({
    projection: {
      type: 'perspective',
      fov: 50,
      aspect: 16 / 9,
      near: 0.1,
      far: 200,
    },
  });

  const show = () =>
    info(
      `floor ${gallery.filtered ? 'filtered' : 'not filtered'} (click to switch)`,
    );
  show();
  canvas.addEventListener('click', () => {
    gallery.filtered = !gallery.filtered;
    show();
  });

  onFrame((time) => {
    galleryCamera(camera, time);
    followAspect(camera, surface);
    renderer.render({
      items: gallery.items,
      lights: [gallery.light],
      camera,
      surface,
      // The lava reads the time.
      time,
      clearColor: { r: 0.55, g: 0.66, b: 0.8, a: 1 },
    });
  });
};

export default example;
