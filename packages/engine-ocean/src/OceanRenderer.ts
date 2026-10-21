import type { Surface } from '@fdw/engine-backend';
import {
  Material,
  RenderGraph,
  RenderGraphRunner,
  Renderer,
} from '@fdw/engine-core';
import type { ScenePassesOptions, TextureHandle } from '@fdw/engine-core';
import { BuiltinTypes, GraphBuilder, std } from '@fdw/engine-shader';
import type { ToneMapping } from '@fdw/engine-shader';
import type { Ocean } from './Ocean';

/** What the passes of an {@link OceanRenderer} draw. */
export type OceanPassesOptions = Omit<
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
  /** The sea, updated for the frame. */
  readonly ocean: Ocean;
};

const toneMappingFunctions: Record<string, string> = {
  reinhard: 'color.toneMapReinhard',
  aces: 'color.toneMapAces',
  neutral: 'color.toneMapNeutral',
};

/**
 * Draws a scene with a sea, in linear colors:
 * 1. the scene (its `source` and `items`), with its view depth;
 * 2. the sky where nothing was drawn, from the environment of the ocean,
 *    copied to a second texture: what is behind the water;
 * 3. the sea over it, tested against the depth of the scene, reading the
 *    copy and the depth: refraction, absorption along the depth of the
 *    water, foam along the shores;
 * then, with {@link OceanRenderer.render}, the tone mapping to the surface.
 *
 * @example
 * ```ts
 * const oceanRenderer = new OceanRenderer(renderer, { toneMapping: 'neutral' });
 * // Each frame:
 * ocean.update(camera.position, time);
 * oceanRenderer.render({ ocean, source: scene, camera, surface, lights: [sun] });
 * ```
 */
export class OceanRenderer {
  readonly renderer: Renderer;
  private readonly _runner: RenderGraphRunner;
  private readonly _toneMapping: Material;
  private readonly _backgrounds = new WeakMap<Ocean, Material>();

  constructor(
    renderer: Renderer,
    options: { toneMapping?: ToneMapping; encoding?: 'srgb' | 'linear' } = {},
  ) {
    this.renderer = renderer;
    const formats = renderer.backend.capabilities?.renderableFormats ?? [];
    if (!formats.includes('rgba16float')) {
      throw new Error(
        'The ocean renderer draws in rgba16float, which the backend cannot render to',
      );
    }
    this._runner = new RenderGraphRunner(renderer.backend);
    this._toneMapping = toneMappingMaterial(
      options.toneMapping ?? 'neutral',
      options.encoding ?? 'srgb',
    );
    this._toneMapping.setValue(
      'hdrSampler',
      renderer.backend.textures.createSampler({
        minFilter: 'nearest',
        magFilter: 'nearest',
        wrapModeS: 'clamp-to-edge',
        wrapModeT: 'clamp-to-edge',
      }),
    );
  }

  /**
   * Adds the passes of the scene, of the sky and of the sea to a render
   * graph; returns the image, in linear colors (rgba16float).
   */
  addPasses(
    graph: RenderGraph,
    { ocean, ...options }: OceanPassesOptions,
  ): TextureHandle {
    const renderer = this.renderer;
    const format = 'rgba16float';
    const scene = renderer.addScenePasses(graph, {
      ...options,
      name: 'scene',
      target: graph.createTexture('ocean scene color', { format }),
      format,
      linear: true,
      samples: 1,
      outputs: { sceneDepth: { format, value: 'view-depth' } },
    });
    const background = renderer.addFullscreenPass(graph, 'ocean background', {
      material: this.background(ocean),
      inputs: { color: scene.color, depth: scene.outputs.sceneDepth },
      target: graph.createTexture('ocean color', { format }),
      format,
      targets: {
        behind: {
          target: graph.createTexture('ocean behind', { format }),
          format,
        },
      },
    });
    const water = renderer.addScenePasses(graph, {
      name: 'ocean',
      items: [ocean],
      camera: options.camera,
      ...(options.time !== undefined ? { time: options.time } : {}),
      ...(options.exposure !== undefined ? { exposure: options.exposure } : {}),
      target: background.color,
      format,
      linear: true,
      load: 'load',
      depth: scene.depth,
      samples: 1,
      shadows: false,
      inputs: ocean.refraction
        ? {
            sceneColor: background.targets.behind,
            sceneDepth: scene.outputs.sceneDepth,
          }
        : {},
    });
    return water.color;
  }

  /** Renders a frame to a surface: {@link OceanRenderer.addPasses}, tone mapped. */
  render({
    surface,
    ...options
  }: OceanPassesOptions & { readonly surface: Surface }): void {
    const current = surface.getCurrentTarget();
    const graph = new RenderGraph({
      size: { width: current.width, height: current.height },
    });
    const hdr = this.addPasses(graph, options);
    this.renderer.addFullscreenPass(graph, 'ocean tone mapping', {
      material: this._toneMapping,
      inputs: { hdr },
      target: graph.importTexture('surface', current),
      format: surface.format,
    });
    this._runner.execute(graph);
    surface.present();
  }

  destroy(): void {
    this._runner.destroy();
  }

  // The sky behind the scene, and the copy of the image for the water.
  private background(ocean: Ocean): Material {
    let material = this._backgrounds.get(ocean);
    if (material) {
      return material;
    }
    const g = new GraphBuilder('ocean background');
    const uv = g.builtin('screen-uv');
    const read = (name: string) =>
      g.call(std.textureSample, {
        texture: g.texture(name),
        sampler: g.sampler(`${name}Sampler`),
        uv,
      });
    const direction = g.call(std.sub, {
      a: g.call('camera.positionFromDepth', { uv, viewDepth: 1 }),
      b: g.engine('camera.position'),
    });
    const sky = g.call(std.mul, {
      a: g
        .call(std.textureSampleCubeLevel, {
          texture: g.texture('environment', { dimension: 'cube' }),
          sampler: g.sampler('environmentSampler'),
          direction,
          level: 0,
        })
        .swizzle('rgb'),
      b: g.uniform('environmentIntensity', BuiltinTypes.f32, { default: 1 }),
    });
    const color = g.call(std.extend, {
      xyz: g.call(std.select, {
        ifFalse: sky,
        ifTrue: read('color').swizzle('rgb'),
        condition: g.call(std.greater, {
          a: read('depth').swizzle('x'),
          b: 0,
        }),
      }),
      w: 1,
    });
    g.fullscreen({ color });
    g.target('behind', color, 1);
    const backend = this.renderer.backend;
    const nearest = backend.textures.createSampler({
      minFilter: 'nearest',
      magFilter: 'nearest',
      wrapModeS: 'clamp-to-edge',
      wrapModeT: 'clamp-to-edge',
    });
    material = new Material({
      graph: g.build(),
      label: 'ocean background',
      values: {
        environment: ocean.material.getValue('environment') as never,
        environmentSampler: ocean.material.getValue(
          'environmentSampler',
        ) as never,
        environmentIntensity: ocean.material.getValue(
          'environmentIntensity',
        ) as never,
        colorSampler: nearest,
        depthSampler: nearest,
      },
    });
    // The water reads the copy and the depth, filtered.
    const linear = backend.textures.createSampler({
      minFilter: 'linear',
      magFilter: 'linear',
      wrapModeS: 'clamp-to-edge',
      wrapModeT: 'clamp-to-edge',
    });
    ocean.material.setValue('sceneColorSampler', linear);
    ocean.material.setValue('sceneDepthSampler', nearest);
    this._backgrounds.set(ocean, material);
    return material;
  }
}

// Tone mapping and encoding of the linear image, for the surface.
function toneMappingMaterial(
  toneMapping: ToneMapping,
  encoding: 'srgb' | 'linear',
): Material {
  const g = new GraphBuilder('ocean output');
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
  return new Material({ graph: g.build(), label: 'ocean output' });
}
