import type { Surface } from '@fdw/engine-backend';
import {
  Material,
  RenderGraph,
  RenderGraphRunner,
  Renderer,
} from '@fdw/engine-core';
import type {
  DirectionalLight,
  ScenePassesOptions,
  TextureHandle,
} from '@fdw/engine-core';
import { Ops } from '@fdw/engine-ocean';
import { arrayType, BuiltinTypes, GraphBuilder, std } from '@fdw/engine-shader';
import type {
  MaterialGraphData,
  PortHandle,
  ToneMapping,
} from '@fdw/engine-shader';
import { cellLattice, sampleLattice } from './grid';
import type { SmokeLayout } from './graphs';
import type { SmokeGrid } from './SmokeGrid';

const vec4Array = arrayType(BuiltinTypes.vec4f);

/**
 * How smoke and fire look: the uniforms of the material of a
 * {@link SmokeRenderer}, in linear colors. Each can change at any time.
 */
export interface SmokeLook {
  /** The share of the light the smoke scatters, per color (its color). */
  readonly albedo: readonly [number, number, number];
  /** The light of the sun, and of the sky all around. */
  readonly sunColor: readonly [number, number, number];
  readonly ambientColor: readonly [number, number, number];
  /** The light of the fire when hot (3 degrees over the threshold), and how bright it gets. */
  readonly fireColor: readonly [number, number, number];
  readonly fireIntensity: number;
  /** Below this temperature, nothing glows. */
  readonly fireThreshold: number;
  /** Forward scattering of the light (Henyey-Greenstein g: 0 all around, 0.9 forward). */
  readonly anisotropy: number;
}

/** The look of gray smoke above an orange fire. */
export const defaultSmokeLook: SmokeLook = {
  albedo: [0.7, 0.7, 0.72],
  sunColor: [2.6, 2.45, 2.2],
  ambientColor: [0.35, 0.4, 0.5],
  fireColor: [6, 2.6, 0.6],
  fireIntensity: 1,
  fireThreshold: 1.5,
  anisotropy: 0.3,
};

/**
 * The full screen material that draws a {@link SmokeGrid} over a scene: for
 * each pixel, a march along the ray of the camera through the box of the
 * grid, up to the scene (its view depth), at `steps` steps shifted by a
 * noise of the pixel (grain instead of bands); at each step the smoke dims
 * what is behind it, scatters the light of the sun that reached it (the
 * `shade` of the grid) and of the sky, and the fire glows.
 *
 * Reads the `color` and `depth` textures (the scene, its view depth in red,
 * 0 where nothing was drawn) and the `smokeShade` buffer.
 */
export function smokeGraph(layout: SmokeLayout): MaterialGraphData {
  const g = new GraphBuilder('smoke');
  const o = new Ops(g);
  const f32 = BuiltinTypes.f32;
  const vec3 = BuiltinTypes.vec3f;
  const look = defaultSmokeLook;
  const uv = g.builtin('screen-uv');
  const read = (name: string) =>
    g.call(std.textureSample, {
      texture: g.texture(name),
      sampler: g.sampler(`${name}Sampler`),
      uv,
    });
  const scene = read('color');
  const viewDepth = read('depth').swizzle('x');
  // The ray of the pixel: p(t) = start + t × direction, t in view depth.
  const start = g.call('camera.positionFromDepth', { uv, viewDepth: 0 });
  const direction = o.sub(
    g.call('camera.positionFromDepth', { uv, viewDepth: 1 }),
    start,
  );
  const sceneT = o.select(1e9, viewDepth, o.greater(viewDepth, 0));
  // The box of the grid, entered and left.
  const low = [layout.origin.x, layout.origin.y, layout.origin.z];
  const high = [
    layout.origin.x + layout.nx * layout.cell,
    layout.origin.y + layout.ny * layout.cell,
    layout.origin.z + layout.nz * layout.cell,
  ];
  const away = o.add(
    direction,
    o.mul(o.sub(o.mul(o.step([0, 0, 0], direction), 2), 1), 1e-7),
  );
  const t1 = o.div(o.sub(low, start), away);
  const t2 = o.div(o.sub(high, start), away);
  const near = o.min(t1, t2);
  const far = o.max(t1, t2);
  const enter = o.max(
    o.max(near.swizzle('x'), o.max(near.swizzle('y'), near.swizzle('z'))),
    0,
  );
  const leave = o.min(
    o.min(far.swizzle('x'), o.min(far.swizzle('y'), far.swizzle('z'))),
    sceneT,
  );
  const steps = g.uniform('steps', BuiltinTypes.u32, { default: 64 });
  const count = o.select(o.u32(0), steps, o.greater(leave, enter));
  const segment = o.div(o.sub(leave, enter), o.convert(o.max(steps, 1), f32));
  const length = o.mul(segment, o.length(direction));
  // A noise of the pixel, from 0 to 1: where each pixel starts its steps.
  const jitter = o.fract(
    o.mul(
      o.sin(o.dot(o.mul(uv, [1731.13, 2911.71]), [12.9898, 78.233])),
      43758.5453,
    ),
  );
  // The light of the sun scattered toward the camera (Henyey-Greenstein).
  const toSun = o.normalize(
    g.uniform('sunDirection', vec3, { default: [0, 1, 0] }),
  );
  const anisotropy = g.uniform('anisotropy', f32, { default: look.anisotropy });
  const cosine = o.dot(o.normalize(o.mul(direction, -1)), o.mul(toSun, -1));
  const g2 = o.mul(anisotropy, anisotropy);
  const phase = o.div(
    o.sub(1, g2),
    o.mul(
      4 * Math.PI,
      o.pow(
        o.max(o.sub(o.add(1, g2), o.mul(o.mul(anisotropy, 2), cosine)), 1e-4),
        1.5,
      ),
    ),
  );
  const sun = o.mul(
    g.uniform('sunColor', vec3, { default: [...look.sunColor] }),
    o.mul(phase, 4 * Math.PI),
  );
  const ambient = g.uniform('ambientColor', vec3, {
    default: [...look.ambientColor],
  });
  const albedo = g.uniform('albedo', vec3, { default: [...look.albedo] });
  const extinction = g.uniform('extinction', f32, { default: 8 });
  const fireColor = g.uniform('fireColor', vec3, {
    default: [...look.fireColor],
  });
  const fireIntensity = g.uniform('fireIntensity', f32, {
    default: look.fireIntensity,
  });
  const fireThreshold = g.uniform('fireThreshold', f32, {
    default: look.fireThreshold,
  });
  const shade = g.storage('smokeShade', vec4Array);
  const march = g.fold([0, 0, 0, 1], count, (state, k) => {
    const t = o.add(enter, o.mul(o.add(o.convert(k, f32), jitter), segment));
    const at = o.add(start, o.mul(direction, t));
    const cell = sampleLattice(o, layout, cellLattice(layout), shade, at);
    const density = o.max(cell.swizzle('x'), 0);
    const absorbed = o.sub(
      1,
      o.exp(o.mul(o.mul(o.mul(density, extinction), length), -1)),
    );
    const lit = o.mul(albedo, o.add(o.mul(sun, cell.swizzle('y')), ambient));
    const transmittance = state.swizzle('w');
    const glow = fireGlow(o, cell.swizzle('z'), fireThreshold, fireColor);
    const added = o.add(
      o.mul(lit, absorbed),
      o.mul(glow, o.mul(fireIntensity, length)),
    );
    return o.extend(
      o.add(state.swizzle('xyz'), o.mul(added, transmittance)),
      o.mul(transmittance, o.sub(1, absorbed)),
    );
  });
  const color = o.add(
    o.mul(scene.swizzle('rgb'), march.swizzle('w')),
    march.swizzle('xyz'),
  );
  g.fullscreen({ color: o.extend(color, 1) });
  return g.build();
}

// The light of a temperature, per meter: nothing below the threshold, then
// growing, deep red when cooler and the fire color when hot (a rough black
// body).
function fireGlow(
  o: Ops,
  temperature: PortHandle,
  threshold: PortHandle,
  color: PortHandle,
): PortHandle {
  const over = o.max(o.sub(temperature, threshold), 0);
  const hot = o.smoothstep(0, 3, over);
  const tint = o.mix(o.mul(color, [0.5, 0.15, 0.05]), color, hot);
  return o.mul(tint, o.mul(over, o.mul(over, 0.25)));
}

/** What {@link SmokeRenderer.render} draws. */
export type SmokeRenderOptions = Omit<
  ScenePassesOptions,
  | 'target'
  | 'format'
  | 'outputs'
  | 'linear'
  | 'load'
  | 'depth'
  | 'include'
  | 'inputs'
  | 'samples'
  | 'name'
> & {
  /** The smoke to draw over the scene, updated for the frame. */
  readonly smoke: SmokeGrid | readonly SmokeGrid[];
  readonly surface: Surface;
};

/**
 * Draws smoke and fire over a scene: {@link SmokeRenderer.addPass} adds the
 * march through a {@link SmokeGrid} to a render graph, after passes that
 * drew the scene in linear colors with its view depth;
 * {@link SmokeRenderer.render} draws a whole frame: the scene, the smoke,
 * the tone mapping.
 *
 * @example
 * ```ts
 * const smokeRenderer = new SmokeRenderer(renderer);
 * // Each frame:
 * smoke.update(dt, bodies);
 * smokeRenderer.render({ smoke, source: scene, camera, surface, lights: [sun] });
 * ```
 */
export class SmokeRenderer {
  readonly renderer: Renderer;
  private readonly _runner: RenderGraphRunner;
  private readonly _materials = new WeakMap<SmokeGrid, Material>();
  private readonly _toneMapping: Material;
  private readonly _passes = new WeakMap<RenderGraph, number>();

  constructor(
    renderer: Renderer,
    options: { toneMapping?: ToneMapping; encoding?: 'srgb' | 'linear' } = {},
  ) {
    this.renderer = renderer;
    const formats = renderer.backend.capabilities?.renderableFormats ?? [];
    if (!formats.includes('rgba16float')) {
      throw new Error(
        'The smoke renderer draws in rgba16float, which the backend cannot render to',
      );
    }
    this._runner = new RenderGraphRunner(renderer.backend);
    this._toneMapping = toneMappingMaterial(
      renderer,
      options.toneMapping ?? 'neutral',
      options.encoding ?? 'srgb',
    );
  }

  /** The material that draws a smoke: its look can change (see {@link SmokeLook}). */
  materialOf(smoke: SmokeGrid): Material {
    let material = this._materials.get(smoke);
    if (!material) {
      const backend = this.renderer.backend;
      const sampler = backend.textures.createSampler({
        minFilter: 'nearest',
        magFilter: 'nearest',
        wrapModeS: 'clamp-to-edge',
        wrapModeT: 'clamp-to-edge',
      });
      material = new Material({
        graph: smokeGraph(smoke.layout),
        label: 'smoke',
        values: { colorSampler: sampler, depthSampler: sampler },
      });
      this._materials.set(smoke, material);
    }
    return material;
  }

  /** Changes how a smoke looks: any uniform of {@link SmokeLook}. */
  setLook(smoke: SmokeGrid, look: Partial<SmokeLook>): this {
    const material = this.materialOf(smoke);
    for (const [name, value] of Object.entries(look)) {
      if (value !== undefined) {
        material.setValue(name, typeof value === 'number' ? value : [...value]);
      }
    }
    return this;
  }

  /** The sun of a smoke: where its light comes from (the grid's too), and its color. */
  setSun(smoke: SmokeGrid, light: DirectionalLight, intensity = 1): this {
    const { x, y, z } = light.direction;
    smoke.sunDirection = [-x, -y, -z];
    const { x: r, y: g, z: b } = light.diffuse;
    this.materialOf(smoke).setValue('sunColor', [
      r * intensity,
      g * intensity,
      b * intensity,
    ]);
    return this;
  }

  /**
   * Adds the march through a smoke to a render graph, over `color` (the
   * scene in linear colors, rgba16float) and `depth` (its view depth);
   * returns the new color.
   */
  addPass(
    graph: RenderGraph,
    {
      smoke,
      color,
      depth,
      steps,
    }: {
      readonly smoke: SmokeGrid;
      readonly color: TextureHandle;
      readonly depth: TextureHandle;
      /** The steps of the march (64). */
      readonly steps?: number;
    },
  ): TextureHandle {
    const material = this.materialOf(smoke);
    material.setValue('smokeShade', smoke.shade);
    material.setValue('sunDirection', [...smoke.sunDirection]);
    material.setValue('extinction', smoke.extinction);
    if (steps !== undefined) {
      material.setValue('steps', steps);
    }
    const format = 'rgba16float';
    // A name per pass: a graph can draw several smokes.
    const count = this._passes.get(graph) ?? 0;
    this._passes.set(graph, count + 1);
    const name = count === 0 ? 'smoke' : `smoke ${count}`;
    return this.renderer.addFullscreenPass(graph, name, {
      material,
      inputs: { color, depth },
      target: graph.createTexture(`${name} color`, { format }),
      format,
    });
  }

  /** Renders a frame: the scene, the smoke, the tone mapping to the surface. */
  render({ surface, smoke, ...options }: SmokeRenderOptions): void {
    const current = surface.getCurrentTarget();
    const graph = new RenderGraph({
      size: { width: current.width, height: current.height },
    });
    const format = 'rgba16float';
    const scene = this.renderer.addScenePasses(graph, {
      ...options,
      name: 'scene',
      target: graph.createTexture('smoke scene color', { format }),
      format,
      linear: true,
      samples: 1,
      outputs: { sceneDepth: { format, value: 'view-depth' } },
    });
    let color = scene.color as TextureHandle;
    for (const grid of Array.isArray(smoke) ? smoke : [smoke as SmokeGrid]) {
      color = this.addPass(graph, {
        smoke: grid,
        color,
        depth: scene.outputs.sceneDepth,
      });
    }
    this.renderer.addFullscreenPass(graph, 'smoke tone mapping', {
      material: this._toneMapping,
      inputs: { hdr: color },
      target: graph.importTexture('surface', current),
      format: surface.format,
    });
    this._runner.execute(graph);
    surface.present();
  }

  destroy(): void {
    this._runner.destroy();
  }
}

const toneMappingFunctions: Record<string, string> = {
  reinhard: 'color.toneMapReinhard',
  aces: 'color.toneMapAces',
  neutral: 'color.toneMapNeutral',
};

/** Tone mapping and encoding of a linear image (the `hdr` texture), for a surface. */
export function toneMappingMaterial(
  renderer: Renderer,
  toneMapping: ToneMapping,
  encoding: 'srgb' | 'linear',
): Material {
  const g = new GraphBuilder('fluids output');
  const texel = g.call(std.textureSample, {
    texture: g.texture('hdr'),
    sampler: g.sampler('hdrSampler'),
    uv: g.builtin('screen-uv'),
  });
  let rgb = texel.swizzle('rgb');
  if (toneMapping !== 'none') {
    rgb = g.call(toneMappingFunctions[toneMapping], {
      color: g.call(std.mul, { a: rgb, b: g.engine('exposure') }),
    });
  }
  if (encoding === 'srgb') {
    rgb = g.call('color.linearToSrgb', { color: rgb });
  }
  g.fullscreen({ color: g.call(std.extend, { xyz: rgb, w: 1 }) });
  return new Material({
    graph: g.build(),
    label: 'fluids output',
    values: {
      hdrSampler: renderer.backend.textures.createSampler({
        minFilter: 'nearest',
        magFilter: 'nearest',
        wrapModeS: 'clamp-to-edge',
        wrapModeT: 'clamp-to-edge',
      }),
    },
  });
}

/**
 * A material that draws a grid of smoke in a plane (2D, one cell along z)
 * on a mesh in the plane of the grid (a quad over it): the smoke lit by the
 * sun that reached it and the sky, the fire glowing, blended over what is
 * behind (`blend` alpha mode). Reads the `smokeShade` buffer (the `shade`
 * of the grid) between the four nearest cells.
 */
export function smokePlaneGraph(layout: SmokeLayout): MaterialGraphData {
  const g = new GraphBuilder('smoke plane');
  const o = new Ops(g);
  const f32 = BuiltinTypes.f32;
  const vec3 = BuiltinTypes.vec3f;
  const look = defaultSmokeLook;
  const world = g
    .call(std.transform, {
      matrix: g.engine('object.world'),
      vector: o.extend(g.attribute('position', vec3)),
    })
    .swizzle('xyz');
  const point = o.perFragment(world);
  const cell = sampleLattice(
    o,
    layout,
    cellLattice(layout),
    g.storage('smokeShade', vec4Array),
    point,
  );
  const density = o.max(cell.swizzle('x'), 0);
  // As thick as the depth of the grid, seen across.
  const thickness = g.uniform('thickness', f32, { default: layout.cell * 4 });
  const extinction = g.uniform('extinction', f32, { default: 8 });
  const alpha = o.sub(
    1,
    o.exp(o.mul(o.mul(o.mul(density, extinction), thickness), -1)),
  );
  const lit = o.mul(
    g.uniform('albedo', vec3, { default: [...look.albedo] }),
    o.add(
      o.mul(
        g.uniform('sunColor', vec3, { default: [...look.sunColor] }),
        cell.swizzle('y'),
      ),
      g.uniform('ambientColor', vec3, { default: [...look.ambientColor] }),
    ),
  );
  const glow = o.mul(
    fireGlow(
      o,
      cell.swizzle('z'),
      g.uniform('fireThreshold', f32, { default: look.fireThreshold }),
      g.uniform('fireColor', vec3, { default: [...look.fireColor] }),
    ),
    o.mul(
      g.uniform('fireIntensity', f32, { default: look.fireIntensity }),
      thickness,
    ),
  );
  // The light of the smoke over its opacity, the glow added.
  const color = o.add(lit, o.div(glow, o.max(alpha, 1e-3)));
  g.surface({
    baseColor: color,
    alpha: o.saturate(o.add(alpha, o.mul(o.length(glow), 0.2))),
  });
  return g.build();
}
