import type { GpuSampler, GpuTexture } from '@fdw/engine-backend';
import {
  BuiltinTypes,
  EnvironmentLevels,
  EnvironmentTiles,
  FunctionDefinition,
  GraphBuilder,
  MaterialGraphData,
  Ops,
  PortHandle,
  std,
} from '@fdw/engine-shader';

/**
 * Where the light of an environment comes from:
 * - `panorama`: an equirectangular image (a 2d texture, 2:1, the HDR
 *   panoramas): u around the vertical (0.5 toward -z), v from the zenith
 *   (top) to the nadir. Give it its levels (mipLevelCount) when it is much
 *   larger than the capture;
 * - `cube`: a cube texture;
 * - `sky`: a function graph of the direction (an input `direction`, vec3,
 *   normalized) giving the linear color (an output `color`, vec3): a
 *   procedural sky.
 */
export type EnvironmentSource =
  | { readonly panorama: GpuTexture }
  | { readonly cube: GpuTexture }
  | { readonly sky: FunctionDefinition };

export interface EnvironmentOptions {
  // Multiplies the light of the environment. Default 1.
  readonly intensity?: number;
  // The size of the tiles of the prefiltered atlas, in texels (128 by
  // default): the sharpness of the mirror reflections.
  readonly size?: number;
  // The samples of each texel of the rough levels, and of the irradiance
  // (64 by default): more for a smoother result, prefiltered once.
  readonly samples?: number;
}

/**
 * The environment of a scene, lighting it from every direction
 * (image-based lighting): the sky, a panorama. The renderer prefilters it
 * once, on the GPU, for the pbr and phong shading models (see
 * environmentMembers in engine-shader): the radiance reflected by
 * surfaces of several roughnesses, the irradiance, the table of the split
 * sum. Call update() when the source changes.
 */
export class Environment {
  readonly source: EnvironmentSource;
  // Multiplies the light of the environment; changing it costs nothing.
  intensity: number;
  readonly size: number;
  readonly samples: number;
  private _version = 0;

  constructor(source: EnvironmentSource, options: EnvironmentOptions = {}) {
    this.source = source;
    this.intensity = options.intensity ?? 1;
    this.size = Math.max(4, Math.round(options.size ?? 128));
    this.samples = Math.max(1, Math.round(options.samples ?? 64));
  }

  /** Increased by update(): the renderer prefilters again. */
  get version(): number {
    return this._version;
  }

  /** Prefilters the environment again on the next frame (a new source). */
  update(): void {
    this._version++;
  }
}

/**
 * The size of the prefiltered atlas of an environment, in texels: its
 * tiles and their borders (see environmentMembers in engine-shader).
 */
export const environmentAtlasSize = (size: number) => ({
  width: EnvironmentTiles.x * (size + 2),
  height: EnvironmentTiles.y * (size + 2),
});

/** The rectangle of a tile of the atlas, its border included, in texels. */
export const environmentTile = (tile: number, size: number) => ({
  x: (tile % EnvironmentTiles.x) * (size + 2),
  y: Math.floor(tile / EnvironmentTiles.x) * (size + 2),
  width: size + 2,
  height: size + 2,
});

/**
 * The size of the panorama the source is captured in, before the
 * prefiltering: 4 × 2 texels per texel of a tile.
 */
export const environmentCaptureSize = (size: number) => ({
  width: size * 4,
  height: size * 2,
});

const vec2 = BuiltinTypes.vec2f;
const f32 = BuiltinTypes.f32;

// A count as a float.
const float = (o: Ops, value: PortHandle) => o.convert(value, f32);

// The point of the tile drawn, in [0, 1] (out of it in the border), from
// the uv of the full screen pass drawn over the tile and its border.
function tilePoint(g: GraphBuilder): PortHandle {
  const o = new Ops(g);
  const size = g.uniform('size', f32);
  return o.div(o.sub(o.mul(g.builtin('screen-uv'), o.add(size, 2)), 1), size);
}

// A basis around a normal: two tangents and the normal.
function basis(g: GraphBuilder, n: PortHandle) {
  const o = new Ops(g);
  const up = o.select(
    [1, 0, 0],
    [0, 1, 0],
    o.less(o.abs(n.swizzle('y')), 0.999),
  );
  const t = o.normalize(o.cross(up, n));
  return { t, b: o.cross(n, t), n };
}

// The i-th of `count` points of the unit square, evenly spread (a
// Fibonacci lattice).
function lattice(g: GraphBuilder, i: PortHandle, count: PortHandle) {
  const o = new Ops(g);
  const index = float(o, i);
  return {
    u: o.fract(o.mul(index, 0.6180339887)),
    v: o.div(o.add(index, 0.5), float(o, count)),
  };
}

// The capture, at a direction, at a level whose texels cover `solidAngle`
// (filtered importance sampling, Křivánek and Colbert 2008): fewer samples
// without fireflies.
function captured(
  g: GraphBuilder,
  direction: PortHandle,
  solidAngle: PortHandle,
): PortHandle {
  const o = new Ops(g);
  const texel = g.uniform('captureTexel', f32);
  const level = o.max(
    o.add(o.mul(o.log2(o.div(solidAngle, texel)), 0.5), 1),
    0,
  );
  return g
    .call(std.textureSampleLevel, {
      texture: g.texture('capture'),
      sampler: g.sampler('captureSampler'),
      uv: g.call('environment.equirect', { direction }),
      level,
    })
    .swizzle('rgb');
}

/**
 * The capture of a source: a panorama (the equirectangular map of
 * environment.equirect), each texel averaging 4 × 4 directions of its
 * footprint, then given its levels.
 */
export function captureGraph(source: EnvironmentSource): MaterialGraphData {
  const g = new GraphBuilder('environment capture');
  const o = new Ops(g);
  const uv = g.builtin('screen-uv');
  const texel = g.uniform('texel', vec2);
  const radiance = (direction: PortHandle, at: PortHandle): PortHandle => {
    if ('panorama' in source) {
      return g
        .call(std.textureSampleLevel, {
          texture: g.texture('source'),
          sampler: g.sampler('sourceSampler'),
          uv: at,
          level: g.uniform('sourceLevel', f32),
        })
        .swizzle('rgb');
    }
    if ('cube' in source) {
      return g
        .call(std.textureSampleCubeLevel, {
          texture: g.texture('source', { dimension: 'cube' }),
          sampler: g.sampler('sourceSampler'),
          direction,
          level: g.uniform('sourceLevel', f32),
        })
        .swizzle('rgb');
    }
    return g.call(source.sky, { direction });
  };
  let sum: PortHandle | undefined;
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const at = o.add(
        uv,
        o.mul(texel, [(x + 0.5) / 4 - 0.5, (y + 0.5) / 4 - 0.5]),
      );
      const color = radiance(
        g.call('environment.equirectDirection', { uv: at }),
        at,
      );
      sum = sum ? o.add(sum, color) : color;
    }
  }
  g.fullscreen({ color: o.extend(o.mul(sum as PortHandle, 1 / 16), 1) });
  return g.build();
}

/**
 * A level of radiance of the atlas: for each direction R of the octahedral
 * map, the capture seen by a surface of a roughness (GGX, N = V = R),
 * weighted by N·L (Karis 2013).
 */
export function radianceGraph(): MaterialGraphData {
  const g = new GraphBuilder('environment radiance');
  const o = new Ops(g);
  const count = g.uniform('samples', BuiltinTypes.u32);
  const roughness = g.uniform('roughness', f32);
  const a = o.max(o.mul(roughness, roughness), 1e-3);
  const a2 = o.mul(a, a);
  const n = g.call('environment.octahedralDirection', { uv: tilePoint(g) });
  const { t, b } = basis(g, n);
  const sum = g.fold([0, 0, 0, 0], count, (state, i) => {
    const { u, v } = lattice(g, i, count);
    // A half vector of the GGX distribution.
    const cosTheta = o.sqrt(
      o.div(o.sub(1, v), o.add(1, o.mul(o.sub(a2, 1), v))),
    );
    const sinTheta = o.sqrt(o.max(o.sub(1, o.mul(cosTheta, cosTheta)), 0));
    const phi = o.mul(u, 2 * Math.PI);
    const h = o.add(
      o.add(
        o.mul(t, o.mul(sinTheta, o.cos(phi))),
        o.mul(b, o.mul(sinTheta, o.sin(phi))),
      ),
      o.mul(n, cosTheta),
    );
    const l = o.sub(o.mul(h, o.mul(cosTheta, 2)), n);
    const nDotL = o.dot(n, l);
    // Its density for L: D(N·H) / 4 (N·H = V·H).
    const d = o.add(o.mul(o.mul(cosTheta, cosTheta), o.sub(a2, 1)), 1);
    const density = o.div(a2, o.mul(4 * Math.PI, o.max(o.mul(d, d), 1e-12)));
    const solidAngle = o.div(1, o.max(o.mul(float(o, count), density), 1e-12));
    const weight = o.max(nDotL, 0);
    return o.add(
      state,
      o.extend(o.mul(captured(g, l, solidAngle), weight), weight),
    );
  });
  g.fullscreen({
    color: o.extend(
      o.div(sum.swizzle('rgb'), o.max(sum.swizzle('w'), 1e-6)),
      1,
    ),
  });
  return g.build();
}

/**
 * The irradiance of the atlas, divided by π: for each normal of the
 * octahedral map, the average of the capture over directions spread as
 * the cosine (the light a white lambertian surface reflects).
 */
export function irradianceGraph(): MaterialGraphData {
  const g = new GraphBuilder('environment irradiance');
  const o = new Ops(g);
  const count = g.uniform('samples', BuiltinTypes.u32);
  const n = g.call('environment.octahedralDirection', { uv: tilePoint(g) });
  const { t, b } = basis(g, n);
  const sum = g.fold([0, 0, 0], count, (state, i) => {
    const { u, v } = lattice(g, i, count);
    const cosTheta = o.sqrt(o.sub(1, v));
    const sinTheta = o.sqrt(v);
    const phi = o.mul(u, 2 * Math.PI);
    const l = o.add(
      o.add(
        o.mul(t, o.mul(sinTheta, o.cos(phi))),
        o.mul(b, o.mul(sinTheta, o.sin(phi))),
      ),
      o.mul(n, cosTheta),
    );
    // The density: cos θ / π.
    const solidAngle = o.div(
      Math.PI,
      o.mul(float(o, count), o.max(cosTheta, 1e-3)),
    );
    return o.add(state, captured(g, l, solidAngle));
  });
  g.fullscreen({ color: o.extend(o.div(sum, float(o, count)), 1) });
  return g.build();
}

/**
 * The table of the split sum (Karis 2013): for N·V (u) and the roughness
 * (v), the scale (r) and bias (g) of F0 of the light the GGX lobe reflects
 * from a white environment. The geometry term of Smith with k = α / 2.
 */
export function brdfGraph(): MaterialGraphData {
  const g = new GraphBuilder('environment brdf');
  const o = new Ops(g);
  const count = g.uniform('samples', BuiltinTypes.u32);
  const point = o.clamp(tilePoint(g), [0, 0], [1, 1]);
  const nDotV = o.max(point.swizzle('x'), 1e-3);
  const roughness = point.swizzle('y');
  const a = o.max(o.mul(roughness, roughness), 1e-3);
  const a2 = o.mul(a, a);
  const k = o.div(a, 2);
  const view = o.vec3(o.sqrt(o.sub(1, o.mul(nDotV, nDotV))), 0, nDotV);
  const smith = (x: PortHandle) => o.div(x, o.add(o.mul(x, o.sub(1, k)), k));
  const sum = g.fold([0, 0], count, (state, i) => {
    const { u, v } = lattice(g, i, count);
    const cosTheta = o.sqrt(
      o.div(o.sub(1, v), o.add(1, o.mul(o.sub(a2, 1), v))),
    );
    const sinTheta = o.sqrt(o.max(o.sub(1, o.mul(cosTheta, cosTheta)), 0));
    const phi = o.mul(u, 2 * Math.PI);
    const h = o.vec3(
      o.mul(sinTheta, o.cos(phi)),
      o.mul(sinTheta, o.sin(phi)),
      cosTheta,
    );
    const vDotH = o.max(o.dot(view, h), 0);
    const l = o.sub(o.mul(h, o.mul(vDotH, 2)), view);
    const nDotL = o.max(l.swizzle('z'), 0);
    // G × V·H / (N·H × N·V), 0 where L is below the surface.
    const visibility = o.select(
      0,
      o.div(
        o.mul(o.mul(smith(nDotV), smith(nDotL)), vDotH),
        o.max(o.mul(cosTheta, nDotV), 1e-6),
      ),
      o.greater(nDotL, 0),
    );
    const fresnel = o.pow(o.sub(1, vDotH), 5);
    return o.add(
      state,
      o.vec2(o.mul(o.sub(1, fresnel), visibility), o.mul(fresnel, visibility)),
    );
  });
  const table = o.div(sum, float(o, count));
  g.fullscreen({
    color: o.vec4(table.swizzle('x'), table.swizzle('y'), 0, 1),
  });
  return g.build();
}

/** The tile of the atlas of the irradiance, then that of the table. */
export const IrradianceTile = EnvironmentLevels;
export const BrdfTile = EnvironmentLevels + 1;

/** The GPU resources of a prefiltered environment. */
export interface EnvironmentTextures {
  readonly atlas: GpuTexture;
  readonly capture: GpuTexture;
  readonly sampler: GpuSampler;
}
