import { Material, Mesh } from '@fdw/engine-core';
import { colorGraph, triangle } from '@fdw/engine-core/testing';
import { Frustum } from '@fdw/engine-geometry';
import { it } from 'vitest';
import { Scene } from './Scene';

it('profiles', () => {
  const mesh: Mesh = triangle();
  const material = new Material({ graph: colorGraph() });
  for (let round = 0; round < 3; round++) {
    const scene = new Scene();
    const t0 = performance.now();
    const nodes = [];
    for (let i = 0; i < 100_000; i++) {
      nodes.push(
        scene.root.add({
          position: { x: i % 1000, z: Math.floor(i / 1000) },
          static: true,
        }),
      );
    }
    const t1 = performance.now();
    for (const node of nodes) node.setMesh(mesh, material);
    const t2 = performance.now();
    scene.query(new Frustum(), ~0, () => undefined, 'camera');
    const t3 = performance.now();
    console.log(
      `create ${(t1 - t0).toFixed(0)} ms, setMesh ${(t2 - t1).toFixed(
        0,
      )} ms, first query (index) ${(t3 - t2).toFixed(0)} ms`,
    );
  }
});
