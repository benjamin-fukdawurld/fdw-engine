import type {
  GpuSampler,
  GpuTexture,
  RenderBackend,
} from '@fdw/engine-backend';
import { fullMipLevelCount } from '@fdw/engine-backend';

/** A sky of {@link skyColor}: its sun and colors, all in linear colors. */
export interface SkyOptions {
  /** Toward the sun (any length). */
  readonly sun?: { readonly x: number; readonly y: number; readonly z: number };
  /** The color straight up, and at the horizon. */
  readonly zenith?: readonly [number, number, number];
  readonly horizon?: readonly [number, number, number];
  /** Below the horizon: the far sea. */
  readonly ground?: readonly [number, number, number];
  /** The glow around the sun. */
  readonly glow?: readonly [number, number, number];
}

const defaults = {
  sun: { x: 0.3, y: 0.45, z: -0.84 },
  zenith: [0.16, 0.32, 0.62],
  horizon: [0.7, 0.8, 0.9],
  ground: [0.05, 0.09, 0.12],
  glow: [1, 0.85, 0.6],
} as const;

/**
 * The color of a simple daylight sky in a direction (any length), in
 * linear colors: from the horizon to the zenith, a glow and a disk for the
 * sun, the far sea below the horizon.
 */
export function skyColor(
  direction: readonly [number, number, number],
  options: SkyOptions = {},
): [number, number, number] {
  const o = { ...defaults, ...options };
  const [x, y, z] = normalize(direction);
  const [sx, sy, sz] = normalize([o.sun.x, o.sun.y, o.sun.z]);
  const toSun = Math.max(x * sx + y * sy + z * sz, 0);
  if (y < 0) {
    // A band of haze, then the far sea.
    const t = Math.min(-y * 8, 1);
    return [0, 1, 2].map((i) => o.horizon[i] * (1 - t) + o.ground[i] * t) as [
      number,
      number,
      number,
    ];
  }
  const t = Math.pow(y, 0.45);
  const glow = Math.pow(toSun, 48) * 0.6 + Math.pow(toSun, 6) * 0.12;
  const disk = toSun > 0.9993 ? 4 : 0;
  return [0, 1, 2].map(
    (i) => o.horizon[i] * (1 - t) + o.zenith[i] * t + o.glow[i] * (glow + disk),
  ) as [number, number, number];
}

function normalize([x, y, z]: readonly number[]): [number, number, number] {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

/** An environment for the {@link Ocean}: a cube texture, its sampler, its levels. */
export interface SkyEnvironment {
  readonly texture: GpuTexture;
  readonly sampler: GpuSampler;
  /** The levels of the texture: the roughest reflections read the last. */
  readonly levels: number;
  destroy(): void;
}

/**
 * The sky of {@link skyColor} in a cube texture, with its levels (sRGB, 8
 * bits): what the sea reflects, and its light.
 */
export function createSky(
  backend: RenderBackend,
  options: SkyOptions & { readonly size?: number } = {},
): SkyEnvironment {
  const size = options.size ?? 64;
  const faces = new Uint8Array(size * size * 4 * 6);
  // The direction of a texel of a face, from its coordinates in [-1, 1].
  const directions = [
    (u: number, v: number) => [1, -v, -u],
    (u: number, v: number) => [-1, -v, u],
    (u: number, v: number) => [u, 1, v],
    (u: number, v: number) => [u, -1, -v],
    (u: number, v: number) => [u, -v, 1],
    (u: number, v: number) => [-u, -v, -1],
  ];
  const encode = (c: number) =>
    Math.round(
      (c <= 0.0031308
        ? c * 12.92
        : 1.055 * Math.pow(Math.min(c, 1), 1 / 2.4) - 0.055) * 255,
    );
  directions.forEach((direction, face) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = ((x + 0.5) / size) * 2 - 1;
        const v = ((y + 0.5) / size) * 2 - 1;
        const color = skyColor(
          direction(u, v) as [number, number, number],
          options,
        );
        faces.set(
          [...color.map((c) => encode(Math.min(Math.max(c, 0), 1))), 255],
          ((face * size + y) * size + x) * 4,
        );
      }
    }
  });
  const levels = fullMipLevelCount({ width: size });
  const texture = backend.textures.createTexture({
    label: 'sky',
    type: 'cube',
    format: 'rgba8unorm-srgb',
    dimensions: { width: size, height: size, layers: 6 },
    mipLevelCount: levels,
    source: faces,
  });
  const sampler = backend.textures.createSampler({
    minFilter: 'linear',
    magFilter: 'linear',
    mipmapFilter: 'linear',
    wrapModeS: 'clamp-to-edge',
    wrapModeT: 'clamp-to-edge',
  });
  return {
    texture,
    sampler,
    levels,
    destroy: () => {
      texture.destroy();
      sampler.destroy();
    },
  };
}
