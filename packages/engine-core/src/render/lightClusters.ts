import type { Mat4 } from '@fdw/engine-backend';
import { BaseLight, DirectionalLight, PointLight, SpotLight } from '../light';
import { lightRange } from './lightRange';

/**
 * The light clusters of a view (see lightClusterMembers in engine-shader):
 * tiles of the screen along x and y, slices of the view depth (spaced
 * logarithmically between the near and far planes of the camera).
 */
export const LightClusterTiles = { x: 16, y: 9, slices: 24 } as const;

/** The number of clusters of a view. */
export const LightClusterCount =
  LightClusterTiles.x * LightClusterTiles.y * LightClusterTiles.slices;

/**
 * Whether a light reaches every cluster: a directional light, or a point or
 * spot light without range (no attenuation). The global lights come first
 * in the light pool, and are summed everywhere.
 */
export const isGlobalLight = (light: BaseLight): boolean =>
  light instanceof DirectionalLight || lightRange(light) === Infinity;

// A sphere containing what a bounded light reaches: its range around a
// point light; around the cone of a spot light, the smallest sphere
// containing it (from "Cull that cone", Bart Wronski, 2017).
function boundingSphere(
  light: PointLight | SpotLight,
  range: number,
  out: Float64Array,
): void {
  const { x, y, z } = light.position;
  out[0] = x;
  out[1] = y;
  out[2] = z;
  out[3] = range;
  if (!(light instanceof SpotLight)) {
    return;
  }
  const angle = (Math.min(light.outerCutoff, 90) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const { x: dx, y: dy, z: dz } = light.direction;
  const length = Math.hypot(dx, dy, dz) || 1;
  // Wide cones: the circle of the cap; narrow ones: through the apex.
  const [along, radius] =
    angle > Math.PI / 4
      ? [cos * range, Math.sin(angle) * range]
      : [range / (2 * cos), range / (2 * cos)];
  out[0] = x + (dx / length) * along;
  out[1] = y + (dy / length) * along;
  out[2] = z + (dz / length) * along;
  out[3] = radius;
}

/**
 * Assigns the bounded lights of a view to its clusters, on the CPU: the
 * light grid read by the clustered light.sum (two u32 per cluster, the
 * first element of its list and its length, then the lists).
 *
 * Each light is bounded by a sphere; in each slice it crosses, the part of
 * the sphere in the slice is bounded by a box of the view space, projected
 * to find the tiles it covers. Conservative: a light can be listed in a
 * cluster it does not reach (the corners of the boxes), never the
 * opposite.
 */
export class LightClusters {
  private _grid = new Uint32Array(LightClusterCount * 2);
  // The (cluster, light) pairs found, two u32 each.
  private _pairs = new Uint32Array(1024);
  private readonly _counts = new Uint32Array(LightClusterCount);
  private readonly _sphere = new Float64Array(4);
  private readonly _corner = new Float64Array(4);

  /**
   * Fills the grid for the lights given, `first` being the index in the
   * pool of the first of them (after the global lights). Returns the grid
   * (a view of an array reused by the next call) and the values of the
   * frame uniforms: lightClusters (with the `first` global lights) and
   * lightClusterDepth.
   */
  assign(
    lights: readonly BaseLight[],
    first: number,
    view: Mat4,
    projection: Mat4,
    near: number,
    far: number,
  ): {
    grid: Uint32Array<ArrayBuffer>;
    lightClusters: number[];
    lightClusterDepth: number[];
  } {
    const { x: tilesX, y: tilesY, slices } = LightClusterTiles;
    near = Math.max(near, 1e-6);
    far = Math.max(far, near * 1.0001);
    // slice = floor(log2(depth) × scale + bias): 0 at the near plane,
    // `slices` at the far one.
    const scale = slices / Math.log2(far / near);
    const bias = -Math.log2(near) * scale;
    const depthOf = (slice: number) => near * (far / near) ** (slice / slices);
    const sliceOf = (depth: number) =>
      Math.min(
        slices - 1,
        Math.max(
          0,
          Math.floor(Math.log2(Math.max(depth, 1e-6)) * scale + bias),
        ),
      );
    const tileOf = (ndc: number, tiles: number) =>
      Math.min(tiles - 1, Math.max(0, Math.floor((ndc * 0.5 + 0.5) * tiles)));

    const counts = this._counts;
    counts.fill(0);
    let pairs = 0;
    const sphere = this._sphere;
    const corner = this._corner;
    const v = view;
    const p = projection;
    for (let index = 0; index < lights.length; index++) {
      const light = lights[index];
      const range = lightRange(light);
      if (!(range > 0) || range === Infinity) {
        continue;
      }
      boundingSphere(light as PointLight | SpotLight, range, sphere);
      // The center in view space; the depth along -z.
      const [wx, wy, wz, r] = sphere;
      const cx = v[0] * wx + v[4] * wy + v[8] * wz + v[12];
      const cy = v[1] * wx + v[5] * wy + v[9] * wz + v[13];
      const d = -(v[2] * wx + v[6] * wy + v[10] * wz + v[14]);
      if (d + r < near || d - r > far) {
        continue;
      }
      const lastSlice = sliceOf(d + r);
      for (let slice = sliceOf(d - r); slice <= lastSlice; slice++) {
        // The part of the sphere in the slice: a smaller sphere around the
        // point of the axis in the slice nearest to the center.
        const z0 = slice === 0 ? near : depthOf(slice);
        const z1 = slice === slices - 1 ? far : depthOf(slice + 1);
        const depth = Math.min(Math.max(d, z0), z1);
        const radius = Math.sqrt(Math.max(r * r - (depth - d) ** 2, 0));
        const zMin = Math.max(depth - radius, z0);
        const zMax = Math.min(depth + radius, z1);
        // Its box, projected: the extent of the clip space it covers.
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        let behind = false;
        for (let c = 0; c < 8; c++) {
          const x = cx + (c & 1 ? radius : -radius);
          const y = cy + (c & 2 ? radius : -radius);
          const z = -(c & 4 ? zMax : zMin);
          for (let row = 0; row < 4; row++) {
            corner[row] =
              p[row] * x + p[4 + row] * y + p[8 + row] * z + p[12 + row];
          }
          const w = corner[3];
          if (!(w > 1e-9)) {
            behind = true;
            break;
          }
          const nx = corner[0] / w;
          const ny = corner[1] / w;
          minX = Math.min(minX, nx);
          maxX = Math.max(maxX, nx);
          minY = Math.min(minY, ny);
          maxY = Math.max(maxY, ny);
        }
        if (behind) {
          minX = minY = -1;
          maxX = maxY = 1;
        }
        if (maxX < -1 || minX > 1 || maxY < -1 || minY > 1) {
          continue;
        }
        const x0 = tileOf(minX, tilesX);
        const x1 = tileOf(maxX, tilesX);
        const y0 = tileOf(minY, tilesY);
        const y1 = tileOf(maxY, tilesY);
        const needed = (pairs + (x1 - x0 + 1) * (y1 - y0 + 1)) * 2;
        if (needed > this._pairs.length) {
          const grown = new Uint32Array(
            Math.max(needed, this._pairs.length * 2),
          );
          grown.set(this._pairs.subarray(0, pairs * 2));
          this._pairs = grown;
        }
        for (let ty = y0; ty <= y1; ty++) {
          for (let tx = x0; tx <= x1; tx++) {
            const cluster = (slice * tilesY + ty) * tilesX + tx;
            counts[cluster]++;
            this._pairs[pairs * 2] = cluster;
            this._pairs[pairs * 2 + 1] = first + index;
            pairs++;
          }
        }
      }
    }

    // The lists, in the order of the clusters, after the two u32 of each.
    const header = LightClusterCount * 2;
    if (this._grid.length < header + pairs) {
      this._grid = new Uint32Array(
        Math.max(header + pairs, this._grid.length * 2),
      );
    }
    const grid = this._grid;
    let next = header;
    for (let cluster = 0; cluster < LightClusterCount; cluster++) {
      grid[cluster * 2] = next;
      grid[cluster * 2 + 1] = 0;
      next += counts[cluster];
    }
    for (let i = 0; i < pairs; i++) {
      const cluster = this._pairs[i * 2];
      grid[grid[cluster * 2] + grid[cluster * 2 + 1]++] =
        this._pairs[i * 2 + 1];
    }
    return {
      grid: grid.subarray(0, header + pairs),
      lightClusters: [tilesX, tilesY, slices, first],
      lightClusterDepth: [scale, bias, 0, 0],
    };
  }
}
