import { CameraMath, wgpuMatrixPrimitives } from '@fdw/engine-backend';
import { bench, describe } from 'vitest';
import { PointLight } from '../light';
import { LightClusters } from './lightClusters';
import { writeLightPool } from './lightPool';

// CPU cost of the lights of a frame: the light pool and the assignment of
// the clusters, for lamps of a range of 4 spread over a 200 × 200 ground
// seen from above and in front.

const cameraMath = new CameraMath(wgpuMatrixPrimitives);
const view = cameraMath.getViewMatrix(
  new Float32Array([0, 30, 60]),
  new Float32Array([Math.sin(-0.25), 0, 0, Math.cos(-0.25)]),
);
const projection = cameraMath.getProjectionMatrix({
  type: 'perspective',
  fov: 60,
  aspect: 16 / 9,
  near: 0.1,
  far: 300,
});

const lamps = (count: number) => {
  let seed = 3;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  // Attenuation 1 / (1 + 16 d²): a range of 4.
  return Array.from(
    { length: count },
    () =>
      new PointLight({
        position: { x: (next() - 0.5) * 200, y: 1, z: (next() - 0.5) * 200 },
        quadraticAttenuation: 16,
      }),
  );
};

describe('lights of a frame', () => {
  for (const count of [100, 1000, 4000]) {
    const lights = lamps(count);
    const clusters = new LightClusters();
    let pool: Float32Array<ArrayBuffer> | undefined;
    bench(`${count} lights`, () => {
      pool = writeLightPool(lights, pool);
      clusters.assign(lights, 0, view, projection, 0.1, 300);
    });
  }
});
