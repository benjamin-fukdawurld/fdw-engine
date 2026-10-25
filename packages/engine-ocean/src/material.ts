import { BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import type { MaterialGraphData, PortHandle } from '@fdw/engine-shader';
import { Ops } from './ops';
import type { WaveShader } from './shader';

/**
 * How the water looks: the uniforms of the material of the
 * {@link Ocean}, all in linear colors. Each can change at any time.
 */
export interface WaterLook {
  /** The color of the light scattered by the body of the water. */
  readonly scatterColor: readonly [number, number, number];
  /**
   * How much of each color the water absorbs, per meter: the red fades
   * first, the shallows show the bottom, the deep water its own color.
   */
  readonly absorption: readonly [number, number, number];
  /** The light of the sun through the crests of the waves. */
  readonly subsurfaceColor: readonly [number, number, number];
  readonly foamColor: readonly [number, number, number];
  /** The roughness of the water, beside the waves too small to draw. */
  readonly roughness: number;
  /**
   * The foam: where the jacobian of the motion falls below this value (1
   * on still water, below 1 where the crests squeeze it, 0 where they
   * break).
   */
  readonly foamThreshold: number;
  /** How fast the foam grows past the threshold. */
  readonly foamAmount: number;
  /** The width of the foam along the shores, in meters of water. */
  readonly shoreFoam: number;
  /** How much the waves bend what is seen through the water. */
  readonly refraction: number;
  /** Multiplies the light of the environment. */
  readonly environmentIntensity: number;
}

/** The look of an open sea, blue-green. */
export const defaultWaterLook: WaterLook = {
  scatterColor: [0.004, 0.035, 0.05],
  absorption: [0.45, 0.07, 0.05],
  subsurfaceColor: [0.05, 0.3, 0.25],
  foamColor: [0.85, 0.88, 0.9],
  roughness: 0.25,
  foamThreshold: 0.55,
  foamAmount: 3,
  shoreFoam: 1.2,
  refraction: 0.04,
  environmentIntensity: 1,
};

/** The options of {@link oceanGraph}. */
export interface OceanGraphOptions {
  /**
   * Reads what is behind the water: the scene drawn before it (the
   * `sceneColor` and `sceneDepth` textures, the view depth in the red
   * channel), for the refraction, the absorption by the depth of the water
   * and the foam of the shores. Without it, the water is opaque.
   */
  readonly refraction: boolean;
  /** Where the waves fade out of the vertices (see {@link WaveShader.displacement}). */
  readonly fade: { readonly scale: number; readonly limit: number };
}

/**
 * The material of the sea, on the waves of a {@link WaveShader}: the
 * vertices of the grid moved by the waves, then for each pixel the normal
 * and the jacobian of the waves, and the light:
 * - the reflection of the environment (a cube texture, `environment`)
 *   weighted by the Fresnel term of water, blurrier as the water gets
 *   rougher (the waves too small for the pixel make it rougher);
 * - the sun (`sunDirection`, `sunColor`): a GGX highlight;
 * - what is seen through the water: the scene behind it, bent by the
 *   waves, absorbed along the depth of water, and the light scattered by
 *   the water itself; the sun through the crests (an approximate
 *   subsurface scattering);
 * - the foam, where the waves squeeze the surface and along the shores.
 *
 * An unlit surface: it computes its own light, in linear colors.
 */
export function oceanGraph(
  shader: WaveShader,
  options: OceanGraphOptions,
): MaterialGraphData {
  const g = new GraphBuilder('ocean');
  const o = new Ops(g);
  const vec3 = BuiltinTypes.vec3f;
  const f32 = BuiltinTypes.f32;
  const look = defaultWaterLook;
  const uniform3 = (name: string, value: readonly number[]) =>
    g.uniform(name, vec3, { default: [...value] });
  const uniform = (name: string, value: number) =>
    g.uniform(name, f32, { default: value });

  // --- The vertex stage: the still point of the grid, moved by the waves.
  const world = g
    .call('std.transform', {
      matrix: g.engine('object.world'),
      vector: o.extend(g.attribute('position', vec3)),
    })
    .swizzle('xyz');
  const still = world.swizzle('xz');
  const camera = g.engine('camera.position');
  const distance = o.length(o.sub(world, camera));
  const displacement = shader.displacement(g, still, distance, options.fade);

  // --- The fragment stage: the waves at the still point of the pixel.
  const xz = o.perFragment(still);
  const position = o.perFragment(o.add(world, displacement));
  const width = o.fwidth(xz);
  const footprint = o.max(width.swizzle('x'), width.swizzle('y'));
  const { slopes, squeeze, lostSlopes } = shader.derivatives(g, xz, footprint);
  const dhdx = slopes.swizzle('x');
  const dhdz = slopes.swizzle('y');
  const dxdx = squeeze.swizzle('x');
  const dzdz = squeeze.swizzle('y');
  const dxdz = squeeze.swizzle('z');
  // The tangents along x and z; the normal, their cross product.
  const tangentX = o.vec3(o.add(dxdx, 1), dhdx, dxdz);
  const tangentZ = o.vec3(dxdz, dhdz, o.add(dzdz, 1));
  const n = o.normalize(o.cross(tangentZ, tangentX));
  const jacobian = o.sub(
    o.mul(o.add(dxdx, 1), o.add(dzdz, 1)),
    o.mul(dxdz, dxdz),
  );

  const v = o.normalize(o.sub(camera, position));
  const nDotV = o.max(o.dot(n, v), 1e-3);
  // Fresnel (Schlick) of water: 2 % straight down, all at grazing angles.
  const fresnel = o.add(0.02, o.mul(0.98, o.pow(o.sub(1, nDotV), 5)));
  // GGX α², with the slopes of the waves left out.
  const roughness = uniform('roughness', look.roughness);
  const alpha2 = o.clamp(
    o.add(
      o.mul(o.mul(roughness, roughness), o.mul(roughness, roughness)),
      o.mul(lostSlopes, 2),
    ),
    1e-4,
    1,
  );
  const alpha = o.sqrt(alpha2);

  // The environment: reflected, its level by the roughness; and the light
  // of the sky from above (its last levels), for the water and the foam.
  const environment = {
    texture: g.texture('environment', { dimension: 'cube' }),
    sampler: g.sampler('environmentSampler'),
  };
  const levels = uniform('environmentLevels', 6);
  const intensity = uniform('environmentIntensity', look.environmentIntensity);
  const sampleEnvironment = (
    direction: PortHandle,
    level: PortHandle | number,
  ) =>
    o.mul(
      g
        .call('std.textureSampleCubeLevel', {
          ...environment,
          direction,
          level,
        })
        .swizzle('rgb'),
      intensity,
    );
  const reflected = o.reflect(o.mul(v, -1), n);
  // Not below the horizon: the waves would show the inside of the sea.
  const upward = o.normalize(
    o.vec3(
      reflected.swizzle('x'),
      o.max(reflected.swizzle('y'), 0.01),
      reflected.swizzle('z'),
    ),
  );
  const reflection = sampleEnvironment(upward, o.mul(o.sqrt(alpha), levels));
  const sky = sampleEnvironment(g.constant(vec3, [0, 1, 0]), levels);

  // The sun: GGX, Smith-Schlick, Fresnel on the half vector.
  const sunColor = uniform3('sunColor', [3, 2.85, 2.6]);
  const l = o.normalize(uniform3('sunDirection', [0.3, 0.45, -0.84]));
  const h = o.normalize(o.add(l, v));
  const nDotL = o.max(o.dot(n, l), 0);
  const nDotH = o.max(o.dot(n, h), 0);
  const vDotH = o.max(o.dot(v, h), 0);
  const d = o.add(o.mul(o.mul(nDotH, nDotH), o.sub(alpha2, 1)), 1);
  const distribution = o.div(alpha2, o.mul(Math.PI, o.mul(d, d)));
  const k = o.mul(alpha, 0.5);
  const smith = (x: PortHandle) => o.div(x, o.add(o.mul(x, o.sub(1, k)), k));
  const sunFresnel = o.add(0.02, o.mul(0.98, o.pow(o.sub(1, vDotH), 5)));
  const specular = o.mul(
    sunColor,
    o.div(
      o.mul(o.mul(distribution, o.mul(smith(nDotL), smith(nDotV))), sunFresnel),
      o.add(o.mul(4, nDotV), 1e-4),
    ),
  );
  // The light reaching the water: the sun from above, the sky.
  const daylight = o.add(
    sky,
    o.mul(sunColor, o.mul(o.max(l.swizzle('y'), 0), 1 / Math.PI)),
  );
  const scattered = o.mul(
    uniform3('scatterColor', look.scatterColor),
    daylight,
  );

  // The sun through the crests: toward the sun, more on the high water.
  const height = o.perFragment(displacement.swizzle('y'));
  const crest = o.saturate(o.add(o.mul(height, 0.4), 0.5));
  const backlight = o.pow(o.saturate(o.dot(o.mul(v, -1), l)), 4);
  const subsurface = o.mul(
    o.mul(uniform3('subsurfaceColor', look.subsurfaceColor), sunColor),
    o.mul(o.mul(crest, o.add(backlight, 0.05)), o.sub(1, fresnel)),
  );

  // What is seen through the water.
  let transmitted: PortHandle = scattered;
  let shore: PortHandle | number = 0;
  let behind: PortHandle | undefined;
  let edge: PortHandle | undefined;
  if (options.refraction) {
    const read = (name: string, uv: PortHandle) =>
      g.call('std.textureSample', {
        texture: g.texture(name),
        sampler: g.sampler(`${name}Sampler`),
        uv,
      });
    const clip = g.call('std.transform', {
      matrix: g.engine('camera.viewProjection'),
      vector: o.extend(position),
    });
    const uv = o.add(
      o.mul(o.div(clip.swizzle('xy'), clip.swizzle('w')), [0.5, -0.5]),
      0.5,
    );
    const depth = o.mul(
      g
        .call('std.transform', {
          matrix: g.engine('camera.view'),
          vector: o.extend(position),
        })
        .swizzle('z'),
      -1,
    );
    // The view depth of the scene; nothing (0) is far away.
    const sceneDepth = (at: PortHandle) => {
      const value = read('sceneDepth', at).swizzle('x');
      return o.select(value, 1e4, o.less(value, 1e-4));
    };
    const straight = o.sub(sceneDepth(uv), depth);
    // Bent by the waves, less where the water is thin; not toward what is
    // in front of the water.
    const bent = o.add(
      uv,
      o.mul(
        n.swizzle('xz'),
        o.mul(
          uniform('refraction', look.refraction),
          o.saturate(o.mul(straight, 0.5)),
        ),
      ),
    );
    const bentDepth = o.sub(sceneDepth(bent), depth);
    const front = o.less(bentDepth, 0);
    const seen = o.select(bent, uv, front);
    const thickness = o.max(o.select(bentDepth, straight, front), 0);
    const transmittance = o.exp(
      o.mul(uniform3('absorption', look.absorption), o.mul(thickness, -1)),
    );
    transmitted = o.add(
      o.mul(read('sceneColor', seen).swizzle('rgb'), transmittance),
      o.mul(scattered, o.sub(1, transmittance)),
    );
    shore = o.sub(
      1,
      o.smoothstep(0, uniform('shoreFoam', look.shoreFoam), o.max(straight, 0)),
    );
    behind = read('sceneColor', uv).swizzle('rgb');
    // The water fades in over its first centimeters at the shores.
    edge = o.saturate(o.mul(straight, 8));
  }
  let color = o.add(
    o.mix(o.add(transmitted, subsurface), reflection, fresnel),
    specular,
  );

  // The foam, broken by a noise drifting with time.
  const noise = (scale: number, seed: number, drift: number) =>
    o.add(
      o.mul(
        g.call('noise.simplex2', {
          point: o.add(o.mul(xz, scale), o.mul(g.engine('time'), drift)),
          seed,
        }),
        0.5,
      ),
      0.5,
    );
  const pattern = o.mul(noise(0.7, 3, 0.05), noise(2.3, 7, -0.11));
  const whitecaps = o.saturate(
    o.mul(
      o.sub(uniform('foamThreshold', look.foamThreshold), jacobian),
      uniform('foamAmount', look.foamAmount),
    ),
  );
  const foam = o.saturate(
    o.mul(o.add(whitecaps, o.mul(shore, 0.8)), o.add(o.mul(pattern, 1.6), 0.2)),
  );
  const foamLight = o.mul(
    uniform3('foamColor', look.foamColor),
    o.add(sky, o.mul(sunColor, o.mul(nDotL, 1 / Math.PI))),
  );
  color = o.mix(color, foamLight, foam);
  if (behind && edge) {
    color = o.mix(behind, color, edge);
  }
  const coverage = shader.coverage?.(g, xz);
  g.surface({
    positionOffset: displacement,
    baseColor: color,
    ...(coverage ? { alpha: coverage } : {}),
  });
  return g.build();
}
