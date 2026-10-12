import { Camera, Material, Renderer } from '@fdw/engine-core';
import {
  colorGraph,
  fakeBackend,
  surface,
  triangle,
} from '@fdw/engine-core/testing';
import { Frustum } from '@fdw/engine-geometry';
import { bench, describe } from 'vitest';
import { Scene } from './Scene';

// The targets of design/scenegraph.md §12, with the fake backend: the
// fake camera sees 1000 units around it, the objects are spread over
// 20 000 units, a tenth of them visible.
const count = 10_000;
const mesh = triangle();
const material = new Material({ graph: colorGraph() });

const build = (staticNodes: boolean, n = count) => {
  const scene = new Scene();
  const nodes = Array.from({ length: n }, (_, i) =>
    scene.root
      .add({
        position: { x: (i - n / 2) * 2, y: 0, z: 0 },
        static: staticNodes,
      })
      .setMesh(mesh, material)
  );
  scene.flush();
  return { scene, nodes };
};

const dynamic = build(false);
const moving = dynamic.nodes.slice(0, 1000);
const { backend } = fakeBackend();
const renderer = new Renderer(backend);
const camera = new Camera({ position: { x: 0, y: 0, z: 10 } });
const frustum = Frustum.fromMatrix(
  Float32Array.of(
    0.001,
    0,
    0,
    0,
    0,
    0.001,
    0,
    0,
    0,
    0,
    -0.0005,
    0,
    0,
    0,
    0.495,
    1
  )
);
renderer.render({ source: dynamic.scene, camera, surface });
let time = 0;

describe(`Scene, ${count} nodes, 1000 visible`, () => {
  bench('camera query', () => {
    dynamic.scene.query(frustum, 0xffffffff, () => undefined, 'camera');
  });

  bench('1000 nodes moving, then the query', () => {
    time++;
    for (const node of moving) {
      node.transform.position = { y: Math.sin(time) };
    }
    dynamic.scene.query(frustum, 0xffffffff, () => undefined, 'camera');
  });

  bench('a frame of the Renderer', () => {
    renderer.render({ source: dynamic.scene, camera, surface });
  });

  bench(
    '100 000 static nodes, built and indexed',
    () => {
      build(true, 100_000);
    },
    { iterations: 3 }
  );

  // The same in a batch: Scene.createBatch.
  const many = 100_000;
  const positions = Float32Array.from({ length: many * 3 }, (_, i) =>
    i % 3 === 0 ? (Math.floor(i / 3) - many / 2) * 2 : 0
  );
  bench(
    '100 000 static nodes, created in a batch and indexed',
    () => {
      const scene = new Scene();
      scene.createBatch({
        count: many,
        positions,
        mesh,
        material,
        static: true,
      });
      scene.flush();
    },
    { iterations: 3 }
  );
});
