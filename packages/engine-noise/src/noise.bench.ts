import { bench, describe } from 'vitest';
import { fbm, perlinNoise, simplexNoise, worleyNoise } from './index';

// The cost of the noises per call, as a heightmap computes them: a texel
// of 1024² is a million calls. Run with `npx vitest bench`.
const point2 = [0, 0];
const point3 = [0, 0, 0];
let i = 0;
const next = () => {
  i++;
  point2[0] = point3[0] = (i % 1024) * 0.013;
  point2[1] = point3[1] = Math.floor(i / 1024) * 0.017;
};

describe('a noise at a point', () => {
  bench('fbm 2D, 5 octaves of gradient noise', () => {
    next();
    fbm(point2);
  });
  bench('perlinNoise 3D', () => {
    next();
    perlinNoise(point3);
  });
  bench('simplexNoise 3D', () => {
    next();
    simplexNoise(point3);
  });
  bench('worleyNoise 2D', () => {
    next();
    worleyNoise(point2);
  });
});
