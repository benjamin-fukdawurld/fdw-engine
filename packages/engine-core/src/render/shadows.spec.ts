import { CameraMath, wgpuMatrixPrimitives } from '@fdw/engine-backend';
import { CubeShadowFaces, lightMembers, LightVec4s } from '@fdw/engine-shader';
import { describe, expect, it } from 'vitest';
import { DirectionalLight, PointLight, SpotLight } from '../light';
import { writeLightPool } from './lightPool';
import {
  castsShadow,
  cubeFaceTangent,
  lookAxes,
  ShadowCameras,
  ShadowTile,
} from './shadows';

const cameraMath = new CameraMath(wgpuMatrixPrimitives);
const receivers = { center: [0, 0, 0] as const, radius: 10 };

// A point, world to clip space by a matrix (column-major).
function project(matrix: Float32Array, p: readonly number[]): number[] {
  const clip = [0, 0, 0, 0];
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 4; column++) {
      clip[row] += matrix[column * 4 + row] * (column < 3 ? p[column] : 1);
    }
  }
  return clip;
}

// Where a point falls in the atlas, and its depth, by the matrix of a tile:
// what the shadow pass draws.
function byMatrix(tile: ShadowTile, p: readonly number[]) {
  const clip = project(tile.matrix, p);
  const [x, y, z] = clip.slice(0, 3).map((v) => v / clip[3]);
  const [ox, oy, w, h] = tile.rect;
  return {
    u: ox + (0.5 + 0.5 * x) * w,
    v: oy + (0.5 - 0.5 * y) * h,
    depth: z,
  };
}

// The same by the parameters of the faces in the light pool, as the shaders
// compute it: the dominant axis gives the face, the axes of the face the
// uv.
function byFaces(
  faces: Float32Array,
  light: PointLight,
  p: readonly number[],
): { face: number; u: number; v: number; depth: number } {
  const [first, columns, tile, tangent, a, b] = faces;
  const { x, y, z } = light.position;
  const d = [p[0] - x, p[1] - y, p[2] - z];
  const abs = d.map(Math.abs);
  const axis =
    abs[0] >= abs[1] && abs[0] >= abs[2] ? 0 : abs[1] >= abs[2] ? 1 : 2;
  const face = axis * 2 + (d[axis] > 0 ? 0 : 1);
  const m = abs[axis];
  const { right, up } = CubeShadowFaces[face];
  const dot = (e: readonly number[]) => d[0] * e[0] + d[1] * e[1] + d[2] * e[2];
  const slot = first + face;
  return {
    face,
    u: ((slot % columns) + 0.5 + (0.5 * dot(right)) / (m * tangent)) * tile,
    v:
      (Math.floor(slot / columns) + 0.5 - (0.5 * dot(up)) / (m * tangent)) *
      tile,
    depth: a + b / m,
  };
}

describe('the shadows of point lights', () => {
  it('casts shadows when asked to', () => {
    expect(castsShadow(new PointLight())).toBe(false);
    expect(castsShadow(new PointLight({ castShadow: true }))).toBe(true);
  });

  it('has faces whose axes are those of a camera looking along them', () => {
    for (const { forward, right, up } of CubeShadowFaces) {
      const [x, y, z] = forward;
      const axes = lookAxes({ x, y, z });
      expect(axes.x.map((v) => v + 0)).toEqual([...right]);
      expect(axes.y.map((v) => v + 0)).toEqual([...up]);
    }
  });

  it('gives a point light six tiles in a row', () => {
    const sun = new DirectionalLight({ castShadow: true });
    const lamp = new PointLight({
      position: { x: 1, y: 2, z: 3 },
      castShadow: true,
    });
    const spot = new SpotLight({ castShadow: true });
    const tiles = new ShadowCameras(cameraMath).tiles(
      [sun, lamp, spot],
      receivers,
      undefined,
      2048,
    );
    // 8 slots: a grid of 3 × 3.
    expect(tiles).toHaveLength(8);
    expect(tiles.map(({ light }) => light)).toEqual([
      sun,
      ...Array(6).fill(lamp),
      spot,
    ]);
    expect(tiles.slice(1, 7).map(({ face }) => face)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    expect(tiles[1].shadow[0]).toBe(3);
    expect(tiles[1].faces?.slice(0, 4)).toEqual(
      new Float32Array([
        1,
        3,
        Math.floor(2048 / 3) / 2048,
        cubeFaceTangent(682),
      ]),
    );
    expect(tiles[2].faces).toBeUndefined();
    expect(tiles[0].face).toBeUndefined();
  });

  it('projects a point as the face that sees it does', () => {
    const lamp = new PointLight({
      position: { x: 0.5, y: -1, z: 2 },
      castShadow: true,
    });
    const sun = new DirectionalLight({ castShadow: true });
    const tiles = new ShadowCameras(cameraMath).tiles(
      [sun, lamp],
      receivers,
      undefined,
      1024,
    );
    const faces = tiles[1].faces as Float32Array;
    const directions = [
      [3, 0.4, -0.7],
      [-2, 1, 0.5],
      [0.3, 4, -1.2],
      [-0.9, -2.5, 0.2],
      [1.1, -0.6, 3],
      [0.4, 0.7, -1.5],
      // Near an edge of two faces.
      [2, 1.97, 0.1],
    ];
    const seen = new Set<number>();
    for (const [dx, dy, dz] of directions) {
      const p = [0.5 + dx, -1 + dy, 2 + dz];
      const expected = byFaces(faces, lamp, p);
      seen.add(expected.face);
      const actual = byMatrix(tiles[1 + expected.face], p);
      expect(actual.u).toBeCloseTo(expected.u, 5);
      expect(actual.v).toBeCloseTo(expected.v, 5);
      expect(actual.depth).toBeCloseTo(expected.depth, 5);
      // Inside the tile, away from its edges by more than the filter.
      const tile = tiles[1 + expected.face].rect;
      const texel = 1 / 1024;
      expect(actual.u).toBeGreaterThan(tile[0] + 1.5 * texel);
      expect(actual.u).toBeLessThan(tile[0] + tile[2] - 1.5 * texel);
      expect(actual.v).toBeGreaterThan(tile[1] + 1.5 * texel);
      expect(actual.v).toBeLessThan(tile[1] + tile[3] - 1.5 * texel);
      expect(actual.depth).toBeGreaterThan(0);
      expect(actual.depth).toBeLessThan(1);
    }
    expect(seen.size).toBe(6);
  });

  it('writes its faces in the light pool', () => {
    const lamp = new PointLight({ castShadow: true });
    const tiles = new ShadowCameras(cameraMath).tiles(
      [lamp],
      receivers,
      undefined,
      1024,
    );
    const pool = writeLightPool([lamp], undefined, tiles);
    const at = (member: string) => lightMembers[member].offset * 4;
    expect(pool[at('shadow')]).toBe(3);
    expect(pool.slice(at('shadowMatrix'), at('shadowMatrix') + 16)).toEqual(
      tiles[0].faces,
    );
    expect(at('shadowMatrix') + 16).toBe(LightVec4s * 4);
  });

  it('traces rays towards point lights with shadows', () => {
    const lamp = new PointLight({
      castShadow: true,
      shadow: { softness: 0.2 },
    });
    const pool = writeLightPool([lamp], undefined, [], 0.01);
    const at = lightMembers['shadow'].offset * 4;
    expect([...pool.slice(at, at + 4)].map((v) => +v.toFixed(4))).toEqual([
      1, 0, 0.01, 0.2,
    ]);
  });
});
