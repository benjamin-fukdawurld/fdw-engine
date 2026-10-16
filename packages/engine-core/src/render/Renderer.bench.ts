import { bench, describe } from 'vitest';
import { Camera } from '../Camera';
import { DirectionalLight } from '../light';
import {
  colorGraph,
  fakeBackend,
  surface,
  triangle,
} from '../testing/fakeBackend';
import { Transform } from '../Transform';
import { Material } from './Material';
import { Renderer } from './Renderer';

// CPU cost of a frame of the Renderer, without GPU: the fake backend records
// nothing. Programs and pipelines are compiled before measuring.

// Objects on the x axis, `spacing` apart, centered on the camera: the fake
// camera sees 1000 units on each side.
const scene = (
  count: number,
  materials: number,
  shadows = false,
  spacing = 1,
) => {
  const { backend } = fakeBackend();
  const renderer = new Renderer(backend);
  const camera = new Camera({ position: { x: 0, y: 0, z: 10 } });
  const mesh = triangle();
  const shared = Array.from(
    { length: materials },
    (_, i) => new Material({ graph: colorGraph(), label: `material ${i}` }),
  );
  const items = Array.from({ length: count }, (_, i) => ({
    mesh,
    material: shared[i % materials],
    transform: new Transform({
      position: { x: (i - count / 2) * spacing, y: 0, z: 0 },
    }),
  }));
  // A sun casting shadows: a shadow pass drawing every item once more.
  const lights = shadows
    ? [
        new DirectionalLight({
          direction: { x: 0, y: -1, z: 0 },
          castShadow: true,
        }),
      ]
    : [];
  const render = () => renderer.render({ items, camera, surface, lights });
  render();
  return { render, items };
};

describe('Renderer.render', () => {
  for (const count of [1, 100, 1000]) {
    const { render } = scene(count, 1);
    bench(`${count} objects, static`, render);
  }

  const moving = scene(1000, 1);
  let time = 0;
  bench('1000 objects, moving', () => {
    time++;
    for (const item of moving.items) {
      item.transform.position = { y: Math.sin(time) };
    }
    moving.render();
  });

  const { render: manyMaterials } = scene(100, 100);
  bench('100 objects, 100 materials', manyMaterials);

  const { render: shadowed } = scene(1000, 1, true);
  bench('1000 objects, static, sun with shadows', shadowed);

  // A large list: each item is tested against the frustum.
  const { render: culled } = scene(10_000, 1, false, 2);
  bench('10 000 objects in a list, 1000 visible', culled);
});
