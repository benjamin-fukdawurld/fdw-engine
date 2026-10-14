import { Camera, Material } from '@fdw/engine-core';
import { fakeBackend } from '@fdw/engine-core/testing';
import { GraphBuilder } from '@fdw/engine-shader';
import { bench, describe } from 'vitest';
import { patchVertex } from './graph';
import { patchGrid } from './patches';
import { PatchSurface } from './PatchSurface';

// CPU cost of the choice of the levels of a frame: a terrain of 64 × 64
// patches, seen from above it, with and without the culling of the patches
// outside of the view.

const terrain = (cull: boolean) => {
  const { backend } = fakeBackend();
  const g = new GraphBuilder('terrain');
  patchVertex(g);
  g.surface({ baseColor: [1, 1, 1] });
  const surface = new PatchSurface(backend, {
    patches: patchGrid({ width: 1024, depth: 1024, columns: 64, rows: 64 }),
    material: new Material({ graph: g.build() }),
    displacement: 40,
    cull,
  });
  const camera = new Camera({
    position: { x: 0, y: 30, z: 0 },
    projection: {
      type: 'perspective',
      fov: 60,
      aspect: 16 / 9,
      near: 0.5,
      far: 2000,
    },
  });
  let frame = 0;
  return () => {
    camera.position = { x: Math.sin(frame++ * 0.01) * 100 };
    surface.update(camera, { width: 1920, height: 1080 });
  };
};

describe('PatchSurface.update, 4096 patches', () => {
  const culled = terrain(true);
  const all = terrain(false);
  bench('with culling', () => culled());
  bench('without culling', () => all());
});
