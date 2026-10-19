import { Camera, Material, Renderer } from '@fdw/engine-core';
import {
  colorGraph,
  fakeBackend,
  surface,
  triangle,
} from '@fdw/engine-core/testing';
import { bench, describe } from 'vitest';
import { Scene } from './Scene';
import { StaticBatches } from './StaticBatches';

// A heterogeneous static set (design/p12-batching.md): 1000 objects of
// their own meshes, in 4 materials, all in view of the fake camera (1000
// units around it), drawn by the Renderer on the fake backend: the cost of
// the CPU only.
const count = 1000;
const materials = Array.from(
  { length: 4 },
  () => new Material({ graph: colorGraph() }),
);
const build = () => {
  const scene = new Scene();
  for (let i = 0; i < count; i++) {
    scene.root
      .add({
        position: { x: (i % 32) * 20 - 320, y: Math.floor(i / 32) * 20 - 320 },
        static: true,
      })
      .setMesh(triangle(), materials[i % materials.length]);
  }
  scene.flush();
  return scene;
};

const { backend } = fakeBackend();
const camera = new Camera({ position: { x: 0, y: 0, z: 10 } });
const alone = build();
const batched = build();
new StaticBatches(batched, { cellSize: 200 });
const renderer = new Renderer(backend);
renderer.render({ source: alone, camera, surface });
renderer.render({ source: batched, camera, surface });

describe(`StaticBatches, ${count} different meshes`, () => {
  bench('a frame of the Renderer, each object drawn alone', () => {
    renderer.render({ source: alone, camera, surface });
  });

  bench('a frame of the Renderer, in static batches', () => {
    renderer.render({ source: batched, camera, surface });
  });

  bench(
    'the batches built',
    () => {
      const scene = build();
      new StaticBatches(scene, { cellSize: 200 });
      scene.flush();
    },
    { iterations: 5 },
  );
});
