import type { GpuTexture } from '@fdw/engine-backend';
import { bakeTexture, Material, type Renderer } from '@fdw/engine-core';
import {
  BuiltinTypes,
  GraphBuilder,
  std,
  stdMacros,
  stdMapping,
  stdNoise,
  stdPatterns,
} from '@fdw/engine-shader';
import type {
  ConstantValue,
  MaterialGraphData,
  PortHandle,
} from '@fdw/engine-shader';

// Procedural materials: computed from the position of each pixel with the
// noises and the patterns of the standard library, without textures nor
// uv (except the bricks and the tiles), at any distance, animated for the
// lava. The gallery of the demo and of the documentation shows them.

type Value = PortHandle | ConstantValue;

// Shorthands for the standard functions.
function shorthands(g: GraphBuilder) {
  const splat = (x: Value) => g.call(std.vec3, { x, y: x, z: x });
  return {
    add: (a: Value, b: Value) => g.call(std.add, { a, b }),
    sub: (a: Value, b: Value) => g.call(std.sub, { a, b }),
    mul: (a: Value, b: Value) => g.call(std.mul, { a, b }),
    // A color between two, by a float.
    mix: (a: Value, b: Value, t: Value) =>
      g.call(std.mix, { a, b, t: splat(t) }),
    smoothstep: (low: Value, high: Value, x: Value) =>
      g.call(std.smoothstep, { low, high, x }),
    // From [-1, 1] to [0, 1].
    unit: (x: Value) =>
      g.call(std.add, { a: g.call(std.mul, { a: x, b: 0.5 }), b: 0.5 }),
  };
}

/**
 * A floor checkerboard of squares of `size` meters in the world, averaged
 * over the pixels (`filtered`, default) or not: far away, the squares
 * smaller than a pixel flicker without the filter, turn gray with it.
 */
export function checkerGraph({
  size = 1,
  filtered = true,
}: { size?: number; filtered?: boolean } = {}): MaterialGraphData {
  const g = new GraphBuilder(filtered ? 'filtered checker' : 'checker');
  const { mix, mul } = shorthands(g);
  const position = g.call(stdMapping.worldPosition);
  const uv = mul(position.swizzle('xz'), 1 / size);
  const value = g.call(
    filtered ? stdPatterns.checkerFiltered : stdPatterns.checker,
    { uv },
  );
  g.surface({
    shadingModel: 'pbr',
    baseColor: mix([0.1, 0.1, 0.11], [0.34, 0.33, 0.31], value),
    roughness: 0.7,
    metallic: 0,
  });
  return g.build();
}

/**
 * Wood: rings around the y axis of the object, warped by a noise, their
 * early and late wood, fine streaks along the grain.
 */
export function woodGraph(): MaterialGraphData {
  const g = new GraphBuilder('wood');
  const { add, mul, mix, smoothstep, unit } = shorthands(g);
  const p = mul(g.call(stdMapping.objectPosition), 3);
  // The rings wander a little: the domain warped by a low noise.
  const warped = g.call(
    stdNoise.warp,
    { point: p.swizzle('xz'), strength: 0.12, seed: 2 },
    { params: { octaves: 2, noise: 'simplex' } },
  );
  const radius = add(
    g.call(std.length, { x: warped }),
    mul(g.call('noise.perlin3', { point: mul(p, [0.6, 0.15, 0.6]) }), 0.4),
  );
  const ring = g.call(std.fract, { x: mul(radius, 7) });
  // Light early wood, then the darker late wood at the end of each ring.
  const late = smoothstep(0.55, 0.95, ring);
  const grain = unit(
    g.call('noise.perlin3', { point: mul(p, [30, 1.5, 30]), seed: 5 }),
  );
  const color = mul(
    mix([0.64, 0.4, 0.2], [0.33, 0.17, 0.07], late),
    add(0.82, mul(grain, 0.25)),
  );
  g.surface({
    shadingModel: 'pbr',
    baseColor: color,
    roughness: add(0.45, mul(late, 0.2)),
    metallic: 0,
  });
  return g.build();
}

/**
 * Marble: a domain warped twice, its veins the ridges of a sine of the
 * warped point, polished.
 */
export function marbleGraph(): MaterialGraphData {
  const g = new GraphBuilder('marble');
  const { add, mul, mix, sub } = shorthands(g);
  const p = mul(g.call(stdMapping.objectPosition), 2.2);
  const warped = g.call(
    stdNoise.warp,
    { point: p, strength: 1.1, seed: 9 },
    { params: { octaves: 4, noise: 'simplex' } },
  );
  const wave = g.call(std.sin, {
    x: mul(add(warped.swizzle('x'), mul(warped.swizzle('y'), 0.6)), 5),
  });
  // Thin veins where the sine crosses 0.
  const vein = g.call(std.pow, {
    base: sub(1, g.call(std.abs, { x: wave })),
    exponent: 4,
  });
  const cloud = g.call(
    stdNoise.fbm,
    { point: mul(p, 3), seed: 4 },
    { params: { octaves: 3 } },
  );
  const stone = mix([0.86, 0.85, 0.82], [0.72, 0.73, 0.75], cloud);
  g.surface({
    shadingModel: 'pbr',
    baseColor: mix(stone, [0.22, 0.24, 0.28], vein),
    roughness: 0.12,
    metallic: 0,
  });
  return g.build();
}

/**
 * Rock: cells of a Worley noise (each its own shade, cracks between them)
 * and a fbm of detail, in the space of the object; the relief by bump
 * mapping of the same height.
 */
export function rockGraph(): MaterialGraphData {
  const g = new GraphBuilder('rock');
  const { add, mul, mix, smoothstep, sub, unit } = shorthands(g);
  const p = mul(g.call(stdMapping.objectPosition), 3.5);
  const cells = g.node(stdNoise.worley, { inputs: { point: p, seed: 1 } });
  // The cracks: where the two nearest cells are about as near.
  const crack = sub(
    1,
    smoothstep(0, 0.07, g.call(std.sub, { a: cells.f2, b: cells.f1 })),
  );
  const detail = unit(
    g.call(
      stdNoise.fbm,
      { point: mul(p, 3) },
      { params: { octaves: 4, noise: 'simplex', filtered: true } },
    ),
  );
  const height = add(mul(sub(1, crack), 0.6), mul(detail, 0.4));
  const shade = mix([0.3, 0.28, 0.26], [0.46, 0.42, 0.37], cells.random);
  g.surface({
    shadingModel: 'pbr',
    baseColor: mul(shade, add(0.35, mul(height, 0.75))),
    roughness: 0.85,
    metallic: 0,
    normal: g.call(stdMacros.bumpMapping, { height, scale: 0.025 }),
  });
  return g.build();
}

/**
 * Bricks on the uv of the mesh: each brick its own red, a fine grain,
 * the mortar recessed by bump mapping. Filtered: the joints become a
 * blend far away rather than flickering lines.
 */
export function bricksGraph(): MaterialGraphData {
  const g = new GraphBuilder('bricks');
  const { add, mul, mix, unit } = shorthands(g);
  const uv = g.call(std.perFragment, {
    value: g.attribute('uv', BuiltinTypes.vec2f),
  });
  const bricks = g.node(stdPatterns.bricks, {
    inputs: { uv, size: [0.25, 0.1], mortar: 0.014, bevel: 0.008 },
  });
  const tint = g.call('noise.random2', { point: bricks.cell, seed: 3 });
  const grain = unit(
    g.call(
      stdNoise.fbm,
      { point: mul(uv, 40) },
      { params: { noise: 'value', octaves: 3, filtered: true } },
    ),
  );
  const brick = mul(
    mix([0.5, 0.16, 0.1], [0.66, 0.3, 0.18], tint.swizzle('x')),
    add(0.8, mul(grain, 0.35)),
  );
  g.surface({
    shadingModel: 'pbr',
    baseColor: mix([0.55, 0.53, 0.5], brick, bricks.mask),
    roughness: 0.8,
    metallic: 0,
    normal: g.call(stdMacros.bumpMapping, {
      height: add(mul(bricks.mask, 0.004), mul(grain, 0.001)),
    }),
  });
  return g.build();
}

/**
 * Glazed tiles on the uv of the mesh, with rounded corners: each tile its
 * own blue, a shiny glaze, a rough joint.
 */
export function tilesGraph(): MaterialGraphData {
  const g = new GraphBuilder('tiles');
  const { mul, mix } = shorthands(g);
  const uv = g.call(std.perFragment, {
    value: g.attribute('uv', BuiltinTypes.vec2f),
  });
  const tiles = g.node(stdPatterns.tiles, {
    inputs: { uv, size: [0.2, 0.2], gap: 0.012, radius: 0.02, bevel: 0.006 },
  });
  const tint = g.call('noise.random2', { point: tiles.cell, seed: 8 });
  const glaze = mix([0.1, 0.32, 0.5], [0.2, 0.55, 0.62], tint.swizzle('x'));
  g.surface({
    shadingModel: 'pbr',
    baseColor: mix([0.85, 0.83, 0.78], glaze, tiles.mask),
    roughness: g.call(std.mix, { a: 0.9, b: 0.12, t: tiles.mask }),
    metallic: 0,
    normal: g.call(stdMacros.bumpMapping, {
      height: mul(tiles.mask, 0.003),
    }),
  });
  return g.build();
}

/**
 * Lava: a 4D noise, the 4th coordinate the time, its hot cracks glowing
 * and moving under a dark crust. Animated without any texture.
 */
export function lavaGraph(): MaterialGraphData {
  const g = new GraphBuilder('lava');
  const { mul, mix, smoothstep, sub } = shorthands(g);
  const p = mul(g.call(stdMapping.objectPosition), 2.5);
  const point = g.call(std.extend, {
    xyz: p,
    w: mul(g.engine('time'), 0.25),
  });
  const flow = g.call(
    stdNoise.fbm,
    { point },
    { params: { noise: 'simplex', octaves: 4 } },
  );
  // Hot where the noise is high, the crust elsewhere.
  const heat = smoothstep(0.05, 0.45, flow);
  g.surface({
    shadingModel: 'pbr',
    baseColor: mix([0.06, 0.05, 0.05], [0.25, 0.08, 0.02], heat),
    emissive: mul(mix([0.9, 0.12, 0.01], [1.6, 0.85, 0.2], heat), heat),
    roughness: sub(0.9, mul(heat, 0.5)),
    metallic: 0,
  });
  return g.build();
}

/**
 * A rock texture that tiles: the noises read on a torus of the 4D space
 * (the u and v of the texture as two angles), so that its edges meet.
 * Color in rgb, height in alpha. Expensive (a 4D cellular noise, 81 cells,
 * and a 4D fbm): baked once by {@link bakeRockTexture}.
 */
export function rockTextureGraph(): MaterialGraphData {
  const g = new GraphBuilder('rock texture');
  const { add, mul, mix, smoothstep, sub, unit } = shorthands(g);
  const angles = mul(g.builtin('screen-uv'), 2 * Math.PI);
  const circle = (angle: PortHandle) => ({
    cos: g.call(std.cos, { x: angle }),
    sin: g.call(std.sin, { x: angle }),
  });
  const u = circle(angles.swizzle('x'));
  const v = circle(angles.swizzle('y'));
  // A radius of 1.3: about eight cells across the texture.
  const torus = mul(
    g.call(std.vec4, { x: u.cos, y: u.sin, z: v.cos, w: v.sin }),
    1.3,
  );
  const cells = g.node(stdNoise.worley, { inputs: { point: torus, seed: 6 } });
  const crack = sub(
    1,
    smoothstep(0, 0.09, g.call(std.sub, { a: cells.f2, b: cells.f1 })),
  );
  const detail = unit(
    g.call(
      stdNoise.fbm,
      { point: mul(torus, 2.5), seed: 2 },
      { params: { noise: 'simplex', octaves: 5 } },
    ),
  );
  const height = add(mul(sub(1, crack), 0.55), mul(detail, 0.45));
  const shade = mix([0.3, 0.28, 0.25], [0.45, 0.42, 0.37], cells.random);
  const color = mul(shade, add(0.4, mul(height, 0.7)));
  g.fullscreen({ color: g.call(std.extend, { xyz: color, w: height }) });
  return g.build();
}

/** The tiling rock of {@link rockTextureGraph}, baked with its levels. */
export function bakeRockTexture(
  renderer: Renderer,
  size = 512,
): Promise<GpuTexture> {
  return bakeTexture(renderer, {
    material: new Material({ graph: rockTextureGraph() }),
    width: size,
    label: 'baked rock',
  });
}

/**
 * The baked rock on a mesh without uv: read on the three planes of the
 * axes of the object (triplanar mapping), its height in alpha bumping the
 * normal.
 */
export function triplanarRockGraph(): MaterialGraphData {
  const g = new GraphBuilder('triplanar rock');
  const rock = g.call(stdMapping.triplanarTexture, {
    texture: g.texture('rock'),
    sampler: g.sampler('rockSampler'),
    position: g.call(stdMapping.objectPosition),
    normal: g.call(stdMapping.objectNormal),
    scale: 1.2,
    sharpness: 6,
  });
  g.surface({
    shadingModel: 'pbr',
    baseColor: rock.swizzle('rgb'),
    roughness: 0.8,
    metallic: 0,
    normal: g.call(stdMacros.bumpMapping, {
      height: rock.swizzle('a'),
      scale: 0.02,
    }),
  });
  return g.build();
}
