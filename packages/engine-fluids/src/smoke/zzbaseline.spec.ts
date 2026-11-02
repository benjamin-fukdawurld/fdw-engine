import { it } from 'vitest';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { createSmokeState, stepSmoke, shadeSmoke } from './cpu';
import type { FluidBody } from '../bodies';
const parameters = {
  buoyancy: 1,
  weight: 0.05,
  densityDecay: 0.1,
  cooling: 0.5,
  vorticity: 2,
  iterations: 40,
};
const layout = (nx: number, ny: number, nz: number) => ({
  nx,
  ny,
  nz,
  cell: 0.1,
  origin: { x: (-nx * 0.1) / 2, y: 0, z: (-nz * 0.1) / 2 },
  open: ['-x', '+x', '+y', '-z'] as any,
});
const ball: FluidBody = {
  shape: { type: 'sphere', radius: 0.3 },
  position: { x: 0.05, y: 0.8, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  center: { x: 0.05, y: 0.8, z: 0 },
  velocity: { x: 0.3, y: 0.1, z: -0.2 },
  angularVelocity: { x: 0, y: 0, z: 1 },
};
const fire = {
  x: 0,
  y: 0.25,
  z: 0,
  radius: 0.2,
  density: 3,
  temperature: 4,
  turbulence: 0.5,
};
const wind = {
  x: 0.2,
  y: 0.4,
  z: 0.1,
  radius: 0.15,
  density: 1,
  temperature: 1,
  velocity: { x: 0.5, y: 0.2, z: -0.3 },
};
it('baseline', () => {
  const out: number[][] = [];
  for (const l of [layout(8, 12, 6), layout(14, 18, 1)]) {
    const s = createSmokeState(l);
    const t0 = performance.now();
    for (let n = 0; n < 15; n++)
      stepSmoke(s, 1 / 30, parameters, [ball], [fire, wind], n / 30);
    console.log('ms', performance.now() - t0);
    out.push(
      [...s.velocity],
      [...s.scalars],
      [...s.pressure],
      [...s.vorticity],
      [...s.solids],
      [...shadeSmoke(s, { x: 0.3, y: 1, z: 0.2 }, 8, 6)],
    );
  }
  const f = 'C:/tmp/fluidsbase/base.json';
  if (!existsSync(f)) {
    writeFileSync(f, JSON.stringify(out));
    return;
  }
  const base: number[][] = JSON.parse(readFileSync(f, 'utf8'));
  let worst = 0;
  base.forEach((a, i) =>
    a.forEach((v, j) => {
      worst = Math.max(
        worst,
        Math.abs(v - out[i][j]) / Math.max(1, Math.abs(v)),
      );
      if (out[i].length !== a.length) throw new Error('len');
    }),
  );
  console.log('worst diff', worst);
});
