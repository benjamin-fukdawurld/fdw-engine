import {
  Camera,
  Material,
  Renderer,
  RenderItem,
  Transform,
} from '@fdw/engine-core';
import {
  colorGraph,
  fakeBackend,
  surface,
  triangle,
} from '@fdw/engine-core/testing';
import { bench, describe } from 'vitest';
import { OcclusionCulling } from './OcclusionCulling';

// CPU cost of a frame of 1000 objects in view, 900 of them hidden: drawn
// all, or with the occlusion culling (its passes and the bookkeeping of the
// results included). The fake backend answers the tests at once.

const scene = (occlusion?: OcclusionCulling) => {
  const { backend } = fakeBackend();
  backend.textures.readTexture = async (_texture, region) => {
    const bytes = new Uint8Array((region?.width ?? 0) * (region?.height ?? 0));
    // One object in ten visible.
    bytes.forEach((_, slot) => (bytes[slot] = slot % 10 === 0 ? 255 : 0));
    return bytes.buffer;
  };
  const renderer = new Renderer(backend);
  const camera = new Camera({ position: { x: 0, y: 0, z: 10 } });
  const mesh = triangle();
  // Ten materials: the hidden objects would be ten draw calls more.
  const materials = Array.from(
    { length: 10 },
    () => new Material({ graph: colorGraph() }),
  );
  const items: RenderItem[] = Array.from({ length: 1000 }, (_, i) => ({
    mesh,
    material: materials[i % 10],
    transform: new Transform({ position: { x: i - 500, y: 0, z: 0 } }),
  }));
  const render = () =>
    renderer.render({
      items,
      camera,
      surface,
      ...(occlusion ? { occlusion } : {}),
    });
  return { render };
};

describe('OcclusionCulling', async () => {
  const all = scene();
  const culled = scene(new OcclusionCulling());
  // The results of the first tests.
  for (let i = 0; i < 3; i++) {
    all.render();
    culled.render();
    await new Promise((resolve) => setTimeout(resolve));
  }
  bench('1000 objects, 900 hidden, all drawn', all.render);
  bench('1000 objects, 900 hidden, occlusion culling', async () => {
    culled.render();
    // The readback of the results, as between two frames.
    await Promise.resolve();
  });
});
