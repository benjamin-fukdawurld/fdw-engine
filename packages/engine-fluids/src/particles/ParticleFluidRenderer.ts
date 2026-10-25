import type { Surface } from '@fdw/engine-backend';
import {
  Material,
  Mesh,
  RenderGraph,
  RenderGraphRunner,
  Renderer,
} from '@fdw/engine-core';
import type {
  Camera,
  DirectionalLight,
  MaterialValue,
  ScenePassesOptions,
  TextureHandle,
  WorldRenderItem,
} from '@fdw/engine-core';
import { Aabb } from '@fdw/engine-geometry';
import { defaultWaterLook, Ops } from '@fdw/engine-ocean';
import type { SkyEnvironment, WaterLook } from '@fdw/engine-ocean';
import { arrayType, BuiltinTypes, GraphBuilder, std } from '@fdw/engine-shader';
import type {
  MaterialGraphData,
  PortHandle,
  ToneMapping,
} from '@fdw/engine-shader';
import { freshWaterLook } from '../shallow/WaterSurface';
import { toneMappingMaterial } from '../smoke/SmokeRenderer';
import type { ParticleFluid } from './ParticleFluid';

const vec4Array = arrayType(BuiltinTypes.vec4f);
const format = 'rgba16float';

/**
 * A quad per particle: four corners (uv ±1) at the origin, the vertex
 * 4 × i + k the corner k of particle i; the material moves them.
 */
export function particleQuads(count: number): Mesh {
  const corners = new Float32Array(count * 4 * 2);
  const indices = new Uint32Array(count * 6);
  for (let i = 0; i < count; i++) {
    corners.set([-1, -1, 1, -1, 1, 1, -1, 1], i * 8);
    const a = i * 4;
    indices.set([a, a + 1, a + 2, a, a + 2, a + 3], i * 6);
  }
  return new Mesh({
    label: 'particle quads',
    description: {
      vertexBuffers: [
        {
          stride: 12,
          stepMode: 'vertex',
          attributes: [
            { semantic: 'position', format: 'float32x3', offset: 0 },
          ],
        },
        {
          stride: 8,
          stepMode: 'vertex',
          attributes: [{ semantic: 'uv', format: 'float32x2', offset: 0 }],
        },
      ],
      vertexCount: count * 4,
      indexBuffer: { format: 'uint32', count: indices.length },
    },
    vertices: [new Float32Array(count * 4 * 3), corners],
    indices,
  });
}

/**
 * The spheres of the particles, for the scene passes of a
 * {@link ParticleFluidRenderer}: each quad turned to the camera, its pixels
 * out of the circle discarded; the view depth of the front of the sphere
 * written to the `fluidDepth` output (red). The particles past `active` are
 * folded away.
 */
export function particleDepthGraph(radius: number): MaterialGraphData {
  const g = new GraphBuilder('particle spheres');
  const o = new Ops(g);
  const index = o.div(g.builtin('vertex-index'), 4);
  const center = o
    .index(g.storage('particlePositions', vec4Array), index)
    .swizzle('xyz');
  const corner = g.attribute('uv', BuiltinTypes.vec2f);
  const view = g.engine('camera.view');
  // The axes of the camera in the world: the rows of its rotation.
  const row = (component: 'x' | 'y' | 'z') =>
    o.vec3(
      g
        .call(std.transform, { matrix: view, vector: [1, 0, 0, 0] })
        .swizzle(component),
      g
        .call(std.transform, { matrix: view, vector: [0, 1, 0, 0] })
        .swizzle(component),
      g
        .call(std.transform, { matrix: view, vector: [0, 0, 1, 0] })
        .swizzle(component),
    );
  const used = o.less(
    index,
    g.uniform('active', BuiltinTypes.u32, { default: 0 }),
  );
  const size = o.select(0, radius, used);
  const offset = o.mul(
    o.add(
      o.mul(row('x'), corner.swizzle('x')),
      o.mul(row('y'), corner.swizzle('y')),
    ),
    size,
  );
  // The view depth of the center, then of the front of the sphere.
  const centerDepth = o.mul(
    g
      .call(std.transform, { matrix: view, vector: o.extend(center, 1) })
      .swizzle('z'),
    -1,
  );
  const uv = o.perFragment(corner);
  const r2 = o.dot(uv, uv);
  const front = o.sub(
    o.perFragment(centerDepth),
    o.mul(o.sqrt(o.max(o.sub(1, r2), 0)), radius),
  );
  g.surface({
    positionOffset: o.add(center, offset),
    alpha: o.select(1, 0, o.greater(r2, 1)),
  });
  g.output('fluidDepth', o.vec4(front, 0, 0, 1));
  return g.build();
}

/**
 * A pass of the bilateral filter of the depth of the liquid, along
 * `direction` (a uniform: (1, 0) then (0, 1)): the neighbors at a similar
 * depth are averaged, over about the size of a particle on the screen; the
 * pixels without liquid stay without.
 */
export function smoothDepthGraph(taps = 8): MaterialGraphData {
  const g = new GraphBuilder('liquid smoothing');
  const o = new Ops(g);
  const uv = g.builtin('screen-uv');
  const read = (at: PortHandle) =>
    g
      .call(std.textureSampleLevel, {
        texture: g.texture('fluidDepth'),
        sampler: g.sampler('fluidDepthSampler'),
        uv: at,
        level: 0,
      })
      .swizzle('x');
  const center = read(uv);
  const texel = g.uniform('texel', BuiltinTypes.vec2f, {
    default: [1 / 512, 1 / 512],
  });
  const direction = g.uniform('direction', BuiltinTypes.vec2f, {
    default: [1, 0],
  });
  // The size of a particle on the screen, in pixels: the radius in meters
  // times the pixels per meter at depth 1, over the depth.
  const reach = g.uniform('reach', BuiltinTypes.f32, { default: 100 });
  const pixels = o.div(reach, o.max(center, 1e-3));
  const step = o.clamp(o.div(pixels, taps), 0.5, 6);
  const spread = g.uniform('depthSpread', BuiltinTypes.f32, { default: 0.05 });
  let sum: PortHandle = o.vec2(center, 1);
  for (let k = -taps; k <= taps; k++) {
    if (k === 0) {
      continue;
    }
    const at = o.add(uv, o.mul(o.mul(direction, texel), o.mul(step, k)));
    const depth = read(at);
    const spatial = Math.exp(-((k / (taps / 2)) ** 2) / 2);
    const difference = o.div(o.sub(depth, center), spread);
    const weight = o.select(
      0,
      o.mul(o.exp(o.mul(o.mul(difference, difference), -1)), spatial),
      o.greater(depth, 0),
    );
    sum = o.add(sum, o.vec2(o.mul(depth, weight), weight));
  }
  const smoothed = o.select(
    0,
    o.div(sum.swizzle('x'), sum.swizzle('y')),
    o.greater(center, 0),
  );
  g.fullscreen({ color: o.vec4(smoothed, 0, 0, 1) });
  return g.build();
}

/**
 * The light of the liquid, in a full screen pass: its surface from the
 * smoothed depth (its normals from the depths around), lit as the water of
 * the sea is: the reflection of the sky (Fresnel), the sun, the scene behind
 * bent and absorbed along the thickness of liquid (the depth of the scene
 * behind, minus its own), the light scattered in it. Elsewhere, the scene.
 */
export function liquidShadingGraph(): MaterialGraphData {
  const g = new GraphBuilder('liquid');
  const o = new Ops(g);
  const f32 = BuiltinTypes.f32;
  const vec3 = BuiltinTypes.vec3f;
  const look = { ...defaultWaterLook, ...freshWaterLook };
  const uv = g.builtin('screen-uv');
  const sample = (name: string, at: PortHandle) =>
    g.call(std.textureSampleLevel, {
      texture: g.texture(name),
      sampler: g.sampler(`${name}Sampler`),
      uv: at,
      level: 0,
    });
  const texel = g.uniform('texel', BuiltinTypes.vec2f, {
    default: [1 / 512, 1 / 512],
  });
  const depthAt = (at: PortHandle) => sample('fluidDepth', at).swizzle('x');
  const depth = depthAt(uv);
  const positionAt = (at: PortHandle, d: PortHandle) =>
    g.call('camera.positionFromDepth', { uv: at, viewDepth: d });
  const p = positionAt(uv, depth);
  // The tangents of the surface: toward the closer neighbor in depth, on
  // each axis (an edge does not bend the normal).
  const tangent = (offset: [number, number]) => {
    const forward = o.add(uv, o.mul(texel, offset));
    const backward = o.sub(uv, o.mul(texel, offset));
    const df = depthAt(forward);
    const db = depthAt(backward);
    const useForward = and2(
      o,
      o.greater(df, 0),
      o.select(
        true,
        o.less(o.abs(o.sub(df, depth)), o.abs(o.sub(db, depth))),
        o.greater(db, 0),
      ),
    );
    return o.select(
      o.sub(p, positionAt(backward, db)),
      o.sub(positionAt(forward, df), p),
      useForward,
    );
  };
  const camera = g.engine('camera.position');
  const toCamera = o.normalize(o.sub(camera, p));
  let normal = o.normalize(o.cross(tangent([0, 1]), tangent([1, 0])));
  normal = o.mul(
    normal,
    o.select(-1, 1, o.greater(o.dot(normal, toCamera), 0)),
  );
  // What is behind: the scene, bent by the surface, absorbed on the way.
  const sceneDepth = sample('sceneDepth', uv).swizzle('x');
  const behind = o.select(1e4, sceneDepth, o.greater(sceneDepth, 0));
  const thickness = o.clamp(
    o.sub(behind, depth),
    0,
    g.uniform('maxThickness', f32, { default: 2 }),
  );
  const viewNormal = g.call(std.transform, {
    matrix: g.engine('camera.view'),
    vector: o.extend(normal, 0),
  });
  const refraction = g.uniform('refraction', f32, { default: look.refraction });
  const bent = o.add(
    uv,
    o.mul(
      o.mul(viewNormal.swizzle('xy'), [1, -1]),
      o.mul(refraction, o.min(thickness, 1)),
    ),
  );
  const behindColor = sample('color', bent).swizzle('rgb');
  const absorption = g.uniform('absorption', vec3, {
    default: [...look.absorption],
  });
  const transmitted = o.exp(o.mul(absorption, o.mul(thickness, -1)));
  const cube = g.texture('environment', { dimension: 'cube' });
  const cubeSampler = g.sampler('environmentSampler');
  const intensity = g.uniform('environmentIntensity', f32, {
    default: look.environmentIntensity,
  });
  const environment = (
    direction: PortHandle | number[],
    level: PortHandle | number,
  ) =>
    o.mul(
      g
        .call(std.textureSampleCubeLevel, {
          texture: cube,
          sampler: cubeSampler,
          direction,
          level,
        })
        .swizzle('rgb'),
      intensity,
    );
  const sky = environment(
    [0, 1, 0],
    g.uniform('environmentLevels', f32, { default: 0 }),
  );
  const scatter = o.mul(
    g.uniform('scatterColor', vec3, { default: [...look.scatterColor] }),
    o.mul(sky, 4),
  );
  const body = o.add(
    o.mul(behindColor, transmitted),
    o.mul(scatter, o.sub(1, transmitted)),
  );
  // The reflection, by Fresnel (water: F0 = 0.02).
  const cosine = o.saturate(o.dot(normal, toCamera));
  const fresnel = o.add(0.02, o.mul(0.98, o.pow(o.sub(1, cosine), 5)));
  const reflected = environment(o.reflect(o.mul(toCamera, -1), normal), 0);
  // The sun, a sharp highlight.
  const toSun = o.normalize(
    g.uniform('sunDirection', vec3, { default: [0.4, 0.8, 0.3] }),
  );
  const half = o.normalize(o.add(toSun, toCamera));
  const roughness = g.uniform('roughness', f32, { default: look.roughness });
  const shininess = o.div(
    2,
    o.max(
      o.mul(o.mul(roughness, roughness), o.mul(roughness, roughness)),
      1e-4,
    ),
  );
  const highlight = o.mul(
    g.uniform('sunColor', vec3, { default: [2.6, 2.45, 2.2] }),
    o.mul(
      o.pow(o.saturate(o.dot(normal, half)), o.min(shininess, 2048)),
      o.mul(fresnel, 4),
    ),
  );
  const liquid = o.add(o.mix(body, reflected, fresnel), highlight);
  const scene = sample('color', uv).swizzle('rgb');
  const visible = and2(o, o.greater(depth, 0), o.less(depth, behind));
  g.fullscreen({ color: o.extend(o.select(scene, liquid, visible), 1) });
  return g.build();
}

const and2 = (o: Ops, a: PortHandle, b: PortHandle) => o.select(false, b, a);

/** What {@link ParticleFluidRenderer.render} draws. */
export type ParticleRenderOptions = Omit<
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
  /** The liquid, updated for the frame. */
  readonly liquid: ParticleFluid;
  readonly surface: Surface;
};

/** The options of a {@link ParticleFluidRenderer}. */
export interface ParticleFluidRendererOptions {
  /** What the liquid reflects: a cube texture (see `createSky`). */
  readonly environment: Pick<SkyEnvironment, 'texture' | 'sampler' | 'levels'>;
  readonly toneMapping?: ToneMapping;
  readonly encoding?: 'srgb' | 'linear';
  /** The passes of the filter of the depth, each across then down (3). */
  readonly smoothing?: number;
  /** How the liquid looks (fresh water by default). */
  readonly look?: Partial<WaterLook>;
}

/**
 * Draws a {@link ParticleFluid} as a liquid, in screen space (van der Laan,
 * Green and Sainz 2009): the particles as spheres into a depth of the
 * liquid, smoothed by a bilateral filter so that the spheres melt into a
 * surface, then lit in a full screen pass as the water of the sea is.
 * {@link ParticleFluidRenderer.addPasses} adds them to a render graph after
 * passes that drew the scene in linear colors with its depth;
 * {@link ParticleFluidRenderer.render} draws a whole frame.
 *
 * @example
 * ```ts
 * const liquidRenderer = new ParticleFluidRenderer(renderer, { environment: sky });
 * // Each frame:
 * liquid.update(dt, bodies);
 * liquidRenderer.render({ liquid, source: scene, camera, surface, lights: [sun] });
 * ```
 */
export class ParticleFluidRenderer {
  readonly renderer: Renderer;
  /** The light of the liquid: its look can change (see `WaterLook`). */
  readonly shading: Material;
  private readonly _runner: RenderGraphRunner;
  private readonly _toneMapping: Material;
  private readonly _smoothing: Material[];
  private readonly _items = new WeakMap<
    ParticleFluid,
    { item: WorldRenderItem; material: Material }
  >();
  private readonly _passes: number;

  constructor(renderer: Renderer, options: ParticleFluidRendererOptions) {
    this.renderer = renderer;
    const backend = renderer.backend;
    const formats = backend.capabilities?.renderableFormats ?? [];
    if (!formats.includes(format)) {
      throw new Error(
        `The liquid renderer draws in ${format}, which the backend cannot render to`,
      );
    }
    this._runner = new RenderGraphRunner(backend);
    this._toneMapping = toneMappingMaterial(
      renderer,
      options.toneMapping ?? 'neutral',
      options.encoding ?? 'srgb',
    );
    const linear = backend.textures.createSampler({
      minFilter: 'linear',
      magFilter: 'linear',
      wrapModeS: 'clamp-to-edge',
      wrapModeT: 'clamp-to-edge',
    });
    const nearest = backend.textures.createSampler({
      minFilter: 'nearest',
      magFilter: 'nearest',
      wrapModeS: 'clamp-to-edge',
      wrapModeT: 'clamp-to-edge',
    });
    this._passes = options.smoothing ?? 3;
    const smooth = smoothDepthGraph();
    this._smoothing = [0, 1].map(
      (axis) =>
        new Material({
          graph: smooth,
          label: 'liquid smoothing',
          values: {
            fluidDepthSampler: nearest,
            direction: axis === 0 ? [1, 0] : [0, 1],
          },
        }),
    );
    const environment = options.environment;
    const look = { ...defaultWaterLook, ...freshWaterLook, ...options.look };
    this.shading = new Material({
      graph: liquidShadingGraph(),
      label: 'liquid',
      values: {
        fluidDepthSampler: nearest,
        sceneDepthSampler: nearest,
        colorSampler: linear,
        environment: environment.texture,
        environmentSampler: environment.sampler,
        environmentLevels: Math.max(environment.levels - 1, 0),
        ...lookValues(look),
      },
    });
  }

  /** Changes how the liquid looks: any uniform of `WaterLook`. */
  setLook(look: Partial<WaterLook>): this {
    for (const [name, value] of Object.entries(lookValues(look))) {
      this.shading.setValue(name, value);
    }
    return this;
  }

  /** The sun the liquid reflects: its direction and color, from a light. */
  setSun(light: DirectionalLight, intensity = 1): this {
    const { x, y, z } = light.direction;
    const { x: r, y: g, z: b } = light.diffuse;
    this.shading.setValue('sunDirection', [-x, -y, -z]);
    this.shading.setValue('sunColor', [
      r * intensity,
      g * intensity,
      b * intensity,
    ]);
    return this;
  }

  /** The particles of a liquid as a render item (spheres, for the depth of the liquid). */
  itemOf(liquid: ParticleFluid): WorldRenderItem {
    let entry = this._items.get(liquid);
    if (!entry) {
      const material = new Material({
        graph: particleDepthGraph(liquid.layout.radius),
        label: 'particle spheres',
        renderState: { alphaMode: 'mask' },
      });
      const bounds = new Aabb();
      const { min, max, radius } = liquid.layout;
      bounds.setFrom(
        min.map((v) => v - radius) as [number, number, number],
        max.map((v) => v + radius) as [number, number, number],
      );
      const item: WorldRenderItem = {
        mesh: particleQuads(liquid.layout.count),
        material,
        castShadow: false,
        bounds,
        world: {
          matrix: new Float32Array([
            1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
          ]),
          version: 0,
        },
      };
      entry = { item, material };
      this._items.set(liquid, entry);
    }
    entry.material.setValue('particlePositions', liquid.positions);
    entry.material.setValue('active', liquid.active);
    return entry.item;
  }

  /**
   * Adds the passes of the liquid to a render graph, over `color` (the
   * scene in linear colors, rgba16float), `sceneDepth` (its view depth) and
   * `depth` (its depth buffer: the spheres are tested against it, and
   * written); returns the new color.
   */
  addPasses(
    graph: RenderGraph,
    {
      liquid,
      camera,
      color,
      sceneDepth,
      depth,
    }: {
      readonly liquid: ParticleFluid;
      readonly camera: Camera;
      readonly color: TextureHandle;
      readonly sceneDepth: TextureHandle;
      readonly depth: TextureHandle;
    },
  ): TextureHandle {
    const renderer = this.renderer;
    const spheres = renderer.addScenePasses(graph, {
      name: 'liquid',
      items: [this.itemOf(liquid)],
      camera,
      depth,
      samples: 1,
      shadows: false,
      outputs: { fluidDepth: { format, value: 'material' } },
    });
    if (!graph.size) {
      throw new Error(
        'The liquid passes need a render graph created with its size',
      );
    }
    const { width, height } = graph.size;
    const texel = [1 / width, 1 / height];
    // The pixels of a particle at depth 1.
    const projection = camera.projection;
    const perMeter =
      projection.type === 'perspective'
        ? height / 2 / Math.tan((projection.fov * Math.PI) / 360)
        : height / (projection.top - projection.bottom);
    let fluidDepth = spheres.outputs.fluidDepth;
    for (let pass = 0; pass < this._passes; pass++) {
      for (const [axis, material] of this._smoothing.entries()) {
        material.setValue('texel', texel);
        material.setValue('reach', perMeter * liquid.layout.radius * 2);
        material.setValue('depthSpread', liquid.layout.radius * 3);
        const name = `liquid smoothing ${pass * 2 + axis}`;
        fluidDepth = renderer.addFullscreenPass(graph, name, {
          material,
          inputs: { fluidDepth },
          target: graph.createTexture(`${name} depth`, { format }),
          format,
        });
      }
    }
    this.shading.setValue('texel', texel);
    return renderer.addFullscreenPass(graph, 'liquid', {
      material: this.shading,
      inputs: { fluidDepth, color, sceneDepth },
      target: graph.createTexture('liquid color', { format }),
      format,
    });
  }

  /** Renders a frame: the scene, the liquid, the tone mapping to the surface. */
  render({ surface, liquid, ...options }: ParticleRenderOptions): void {
    const current = surface.getCurrentTarget();
    const graph = new RenderGraph({
      size: { width: current.width, height: current.height },
    });
    const scene = this.renderer.addScenePasses(graph, {
      ...options,
      name: 'scene',
      target: graph.createTexture('liquid scene color', { format }),
      format,
      linear: true,
      samples: 1,
      outputs: { sceneDepth: { format, value: 'view-depth' } },
    });
    const color = this.addPasses(graph, {
      liquid,
      camera: options.camera,
      color: scene.color as TextureHandle,
      sceneDepth: scene.outputs.sceneDepth,
      depth: scene.depth,
    });
    this.renderer.addFullscreenPass(graph, 'liquid tone mapping', {
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

// The uniforms of a look.
function lookValues(look: Partial<WaterLook>): Record<string, MaterialValue> {
  const values: Record<string, MaterialValue> = {};
  for (const [name, value] of Object.entries(look)) {
    if (value !== undefined) {
      values[name] = typeof value === 'number' ? value : [...value];
    }
  }
  return values;
}
