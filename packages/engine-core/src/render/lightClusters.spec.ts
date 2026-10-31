import { CameraMath, wgpuMatrixPrimitives } from '@fdw/engine-backend';
import { describe, expect, it } from 'vitest';
import { DirectionalLight, PointLight, SpotLight } from '../light';
import {
  isGlobalLight,
  LightClusterCount,
  LightClusters,
  LightClusterTiles,
} from './lightClusters';
import { lightRange } from './lightRange';

const cameraMath = new CameraMath(wgpuMatrixPrimitives);

// A deterministic random number generator (a 32-bit LCG), in [0, 1).
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const transform = (m: Float32Array, [x, y, z]: number[]) =>
  [0, 1, 2, 3].map((r) => m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r]);

describe('LightClusters', () => {
  const near = 0.5;
  const far = 200;
  const view = cameraMath.getViewMatrix(
    new Float32Array([3, 2, 10]),
    // Turned a little around y.
    new Float32Array([0, Math.sin(0.2), 0, Math.cos(0.2)]),
  );
  const projection = cameraMath.getProjectionMatrix({
    type: 'perspective',
    fov: 60,
    aspect: 16 / 9,
    near,
    far,
  });
  const viewProjection = cameraMath.getViewProjectionMatrix(view, projection);

  // The cluster of a point, as light.cluster computes it.
  const clusterOf = (
    point: number[],
    [tilesX, tilesY, slices]: number[],
    [scale, bias]: number[],
  ) => {
    const depth = -transform(view, point)[2];
    const clip = transform(viewProjection, point);
    const clamp = (x: number, high: number) => Math.min(Math.max(x, 0), high);
    const slice = clamp(
      Math.floor(Math.log2(Math.max(depth, 1e-6)) * scale + bias),
      slices - 1,
    );
    const tile = (ndc: number, tiles: number) =>
      clamp(Math.floor((ndc * 0.5 + 0.5) * tiles), tiles - 1);
    return (
      (slice * tilesY + tile(clip[1] / clip[3], tilesY)) * tilesX +
      tile(clip[0] / clip[3], tilesX)
    );
  };

  it('lists every light in the clusters of the points it reaches', () => {
    const next = random(7);
    const lights = Array.from({ length: 60 }, (_, i) => {
      const position = {
        x: (next() - 0.5) * 80,
        y: (next() - 0.5) * 40,
        z: -next() * 120,
      };
      return i % 3 === 0
        ? new SpotLight({
            position,
            direction: { x: next() - 0.5, y: -1, z: next() - 0.5 },
            outerCutoff: 10 + next() * 70,
            quadraticAttenuation: 0.05 + next(),
          })
        : new PointLight({ position, quadraticAttenuation: 0.05 + next() });
    });
    const { grid, lightClusters, lightClusterDepth } =
      new LightClusters().assign(lights, 3, view, projection, near, far);
    expect(lightClusters).toEqual([
      LightClusterTiles.x,
      LightClusterTiles.y,
      LightClusterTiles.slices,
      3,
    ]);
    // Points in front of the camera, near the lights.
    let checked = 0;
    for (let n = 0; n < 20000; n++) {
      const light = lights[Math.floor(next() * lights.length)];
      const range = lightRange(light);
      const { x, y, z } = light.position;
      const point = [
        x + (next() - 0.5) * 2 * range,
        y + (next() - 0.5) * 2 * range,
        z + (next() - 0.5) * 2 * range,
      ];
      const clip = transform(viewProjection, point);
      const inView = [0, 1].every((i) => Math.abs(clip[i]) <= clip[3]);
      const depth = -transform(view, point)[2];
      if (!inView || depth < near || depth > far) {
        continue;
      }
      const cluster = clusterOf(point, lightClusters, lightClusterDepth);
      const listed = new Set(
        grid.subarray(
          grid[cluster * 2],
          grid[cluster * 2] + grid[cluster * 2 + 1],
        ),
      );
      for (let i = 0; i < lights.length; i++) {
        const other = lights[i];
        const { x: lx, y: ly, z: lz } = other.position;
        const to = [point[0] - lx, point[1] - ly, point[2] - lz];
        const distance = Math.hypot(...to);
        let reaches = distance < lightRange(other);
        if (reaches && other instanceof SpotLight) {
          const { x: dx, y: dy, z: dz } = other.direction;
          const cosine =
            (to[0] * dx + to[1] * dy + to[2] * dz) /
            (distance * Math.hypot(dx, dy, dz));
          reaches = cosine > Math.cos((other.outerCutoff * Math.PI) / 180);
        }
        if (reaches) {
          checked++;
          expect(listed.has(3 + i)).toBe(true);
        }
      }
    }
    expect(checked).toBeGreaterThan(5000);
    // Far fewer than every light everywhere.
    const listedTotal = grid.length - LightClusterCount * 2;
    expect(listedTotal).toBeLessThan(lights.length * LightClusterCount * 0.1);
  });

  it('leaves out the lights out of the view', () => {
    const behind = new PointLight({
      position: { x: 3, y: 2, z: 40 },
      quadraticAttenuation: 1,
    });
    const { grid } = new LightClusters().assign(
      [behind],
      0,
      view,
      projection,
      near,
      far,
    );
    expect(grid.length).toBe(LightClusterCount * 2);
  });

  it('keeps the directional lights and those without range global', () => {
    expect(isGlobalLight(new DirectionalLight())).toBe(true);
    expect(isGlobalLight(new PointLight())).toBe(true);
    expect(isGlobalLight(new PointLight({ linearAttenuation: 1 }))).toBe(false);
  });
});
