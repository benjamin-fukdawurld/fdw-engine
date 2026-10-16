import type { GpuTexture, RenderBackend } from '@fdw/engine-backend';
import { Material } from '@fdw/engine-core';
import { BuiltinTypes, GraphBuilder, std } from '@fdw/engine-shader';
import type { PortHandle } from '@fdw/engine-shader';
import { patchGrid, PatchSurface, patchVertex } from '@fdw/engine-tessellation';
import { seededRandom } from '../maze/maze';

// A terrain drawn as a surface of patches: a height map moves the points of
// the patches, each tessellated as finely as its size on the screen asks.

/** The shape of a terrain. */
export interface TerrainOptions {
  // The side of the terrain, and the height of its highest point, in meters.
  readonly size?: number;
  readonly height?: number;
  // The patches along a side.
  readonly patches?: number;
  // The texels of the height map along a side.
  readonly resolution?: number;
  // The length of the edges of the triangles on the screen, in pixels.
  readonly edgePixels?: number;
  // The coarsest level of the patches: 6 draws every patch at the finest.
  readonly minLevel?: number;
  readonly seed?: number;
}

/** A terrain, ready to draw. */
export interface Terrain {
  readonly surface: PatchSurface;
  readonly size: number;
  /** The height of the ground at a point, in meters. */
  heightAt(x: number, z: number): number;
  /** Colors the patches by level, from blue (0) to red (6). */
  showLevels(on: boolean): void;
  destroy(): void;
}

/**
 * Heights from 0 to 1: valleys and ridges, the sum of octaves of value
 * noise, the low ones flattened.
 */
export function terrainHeights(resolution: number, seed = 3): Float32Array {
  const lattice = 8;
  const random = seededRandom(seed);
  const values = Float32Array.from({ length: 256 * 256 }, random);
  const noise = (x: number, y: number) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const at = (i: number, j: number) => values[((j & 255) << 8) | (i & 255)];
    const top = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * sx;
    const bottom = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * sx;
    return top + (bottom - top) * sy;
  };
  const heights = new Float32Array(resolution * resolution);
  for (let j = 0; j < resolution; j++) {
    for (let i = 0; i < resolution; i++) {
      let sum = 0;
      let amplitude = 0.5;
      let frequency = lattice / resolution;
      for (let octave = 0; octave < 6; octave++) {
        // Ridges: the noise folded around its middle.
        const n = noise(i * frequency, j * frequency);
        sum += amplitude * (octave < 2 ? n : 1 - Math.abs(2 * n - 1));
        amplitude *= 0.5;
        frequency *= 2;
      }
      heights[j * resolution + i] = Math.min(Math.max(sum, 0), 1) ** 1.8;
    }
  }
  return heights;
}

// A float as a half float (rgba16float textures), rounded to nearest.
function toHalf(value: number): number {
  const floats = new Float32Array([value]);
  const bits = new Uint32Array(floats.buffer)[0];
  const sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  const mantissa = bits & 0x7fffff;
  if (exponent <= 0) {
    return sign;
  }
  if (exponent >= 31) {
    return sign | 0x7c00;
  }
  return sign | (exponent << 10) | Math.round(mantissa / 0x2000);
}

/** The height map of a terrain: its heights in rgba16float. */
export function heightTexture(
  backend: RenderBackend,
  heights: Float32Array,
  resolution: number,
): GpuTexture {
  const pixels = new Uint16Array(resolution * resolution * 4);
  heights.forEach((height, i) => {
    const half = toHalf(height);
    pixels.set([half, half, half, 0x3c00], i * 4);
  });
  return backend.textures.createTexture({
    label: 'terrain heights',
    type: '2d',
    format: 'rgba16float',
    dimensions: { width: resolution, height: resolution },
    source: pixels,
  });
}

/**
 * The material of a terrain: the patches moved by the height map; grass,
 * rock on the slopes, snow up high; the normal read per pixel from the
 * height map, the same at every level of tessellation.
 */
export function terrainGraph({
  size,
  height,
  resolution,
}: {
  size: number;
  height: number;
  resolution: number;
}) {
  const g = new GraphBuilder('terrain');
  const heightMap = {
    texture: g.texture('heightMap'),
    sampler: g.sampler('heightSampler'),
  };
  const texel = 1 / resolution;
  const vertex = patchVertex(g, {
    displacement: { ...heightMap, scale: height, texel },
  });

  // The normal of each pixel: the slopes of the height map.
  const uv = g.call(std.perFragment, { value: vertex.uv });
  const heightAt = (dx: number, dy: number) =>
    g
      .call(std.textureSample, {
        ...heightMap,
        uv: g.call(std.add, { a: uv, b: [dx * texel, dy * texel] }),
      })
      .swizzle('x');
  const slope = (height * resolution) / (2 * size);
  const normal = g.call(std.normalize, {
    x: g.call(std.vec3, {
      x: g.call(std.mul, {
        a: g.call(std.sub, { a: heightAt(-1, 0), b: heightAt(1, 0) }),
        b: slope,
      }),
      y: 1,
      z: g.call(std.mul, {
        a: g.call(std.sub, { a: heightAt(0, -1), b: heightAt(0, 1) }),
        b: slope,
      }),
    }),
  });

  const splat = (value: PortHandle) =>
    g.call(std.vec3, { x: value, y: value, z: value });
  const mix = (a: PortHandle | number[], b: number[], t: PortHandle) =>
    g.call(std.mix, { a, b, t: splat(t) });
  const up = normal.swizzle('y');
  const rock = g.call(std.sub, {
    a: 1,
    b: g.call(std.smoothstep, { low: 0.6, high: 0.8, x: up }),
  });
  const snow = g.call(std.mul, {
    a: g.call(std.smoothstep, {
      low: 0.45,
      high: 0.55,
      x: g.call(std.perFragment, { value: vertex.height }),
    }),
    b: g.call(std.smoothstep, { low: 0.8, high: 0.9, x: up }),
  });
  const ground = mix(
    mix([0.22, 0.34, 0.12], [0.38, 0.33, 0.28], rock),
    [0.92, 0.94, 0.97],
    snow,
  );
  // The level of the patch, from blue to red.
  const level = g.call(std.div, { a: vertex.level, b: 6 });
  const levels = g.call(std.vec3, {
    x: level,
    y: g.call(std.sub, {
      a: 1,
      b: g.call(std.abs, {
        x: g.call(std.sub, { a: g.call(std.mul, { a: level, b: 2 }), b: 1 }),
      }),
    }),
    z: g.call(std.sub, { a: 1, b: level }),
  });
  g.surface({
    shadingModel: 'phong',
    baseColor: g.call(std.mix, {
      a: ground,
      b: levels,
      t: splat(g.uniform('showLevels', BuiltinTypes.f32, { default: 0 })),
    }),
    specular: [0.05, 0.05, 0.05],
    shininess: 8,
    normal,
  });
  return g.build();
}

/** A terrain of hills and ridges, centered on the origin. */
export function buildTerrain(
  backend: RenderBackend,
  options: TerrainOptions = {},
): Terrain {
  const size = options.size ?? 1024;
  const height = options.height ?? 120;
  const resolution = options.resolution ?? 256;
  const heights = terrainHeights(resolution, options.seed);
  const heightMap = heightTexture(backend, heights, resolution);
  const sampler = backend.textures.createSampler({
    minFilter: 'linear',
    magFilter: 'linear',
    mipmapFilter: 'nearest',
    wrapModeS: 'clamp-to-edge',
    wrapModeT: 'clamp-to-edge',
  });
  const material = new Material({
    graph: terrainGraph({ size, height, resolution }),
    values: { heightMap, heightSampler: sampler },
  });
  const patches = options.patches ?? 32;
  const surface = new PatchSurface(backend, {
    patches: patchGrid({
      width: size,
      depth: size,
      columns: patches,
      rows: patches,
    }),
    material,
    edgePixels: options.edgePixels ?? 8,
    minLevel: options.minLevel ?? 0,
    displacement: height,
    label: 'terrain',
  });

  // The height map as the GPU filters it: between the centers of the texels.
  const heightAt = (x: number, z: number) => {
    const at = (i: number, j: number) =>
      heights[
        Math.min(Math.max(j, 0), resolution - 1) * resolution +
          Math.min(Math.max(i, 0), resolution - 1)
      ];
    const u = (x / size + 0.5) * resolution - 0.5;
    const v = (z / size + 0.5) * resolution - 0.5;
    const i = Math.floor(u);
    const j = Math.floor(v);
    const fu = u - i;
    const fv = v - j;
    const top = at(i, j) + (at(i + 1, j) - at(i, j)) * fu;
    const bottom = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * fu;
    return (top + (bottom - top) * fv) * height;
  };

  return {
    surface,
    size,
    heightAt,
    showLevels: (on) => material.setValue('showLevels', on ? 1 : 0),
    destroy: () => {
      surface.destroy();
      heightMap.destroy();
      sampler.destroy();
    },
  };
}
