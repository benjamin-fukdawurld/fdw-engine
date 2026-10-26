import {
  Material,
  RenderGraph,
  Renderer,
  TextureHandle,
} from '@fdw/engine-core';
import {
  BuiltinTypes,
  GraphBuilder,
  MaterialGraphData,
  PortHandle,
  RayMasks,
} from '@fdw/engine-shader';
import type { RayScene } from './RayScene';
import { Shading } from './shading';

export interface RayOcclusionOptions {
  /** How far the rays look for what hides the sky, in world units (1). */
  readonly radius?: number;
  /** Rays per pixel (4): more, less noise; compiled in the program. */
  readonly samples?: number;
}

/** The G-buffer the passes of the rays read: textures of scene outputs. */
export interface RayGBuffer {
  /**
   * The point of each pixel ('world-position', rgba16float), w 1 for the
   * surfaces, 0 for the background (the clear value).
   */
  readonly position: TextureHandle;
  /** Its normal ('world-normal', rgba16float). */
  readonly normal: TextureHandle;
}

// The pixel of a full screen pass, and the texels of the G-buffer there.
function pixelOf(g: GraphBuilder, s: Shading) {
  const pixel = s.convert(
    g.builtin('frag-coord').swizzle('xy'),
    BuiltinTypes.vec2i,
  );
  const load = (name: string, at: PortHandle = pixel) =>
    g.call('std.textureLoad', {
      texture: g.texture(name),
      coords: at,
    });
  return { pixel, load };
}

// The openness of each pixel to the sky: rays in the half sphere of its
// normal (cosine weighted, on a spiral turned by a noise per pixel), the
// share of them that leave without hitting anything within the radius.
function occlusionGraph(samples: number): MaterialGraphData {
  const g = new GraphBuilder('ray occlusion');
  const s = new Shading(g);
  const { pixel, load } = pixelOf(g, s);
  const radius = g.uniform('radius', BuiltinTypes.f32, { default: 1 });
  const position = load('position');
  const normal = s.normalize(load('normal').swizzle('xyz'));
  const frame = s.frame(normal);
  // Interleaved gradient noise (Jimenez 2014).
  const noise = s.fract(
    s.mul(
      s.fract(s.dot(s.convert(pixel, BuiltinTypes.vec2f), [0.06711056, 0.00583715])),
      52.9829189,
    ),
  );
  const origin = s.add(position.swizzle('xyz'), s.mul(normal, 1e-3));
  // A loop rather than unrolled rays: the traversal once in the code.
  const hidden = g.fold(
    s.f32(0),
    samples,
    (sum, index) => {
      const k = s.convert(index, BuiltinTypes.f32);
      const turn = s.mul(s.fract(s.add(noise, s.mul(k, 0.6180339887))), 2 * Math.PI);
      const v = s.div(s.add(k, 0.5), samples);
      const r = s.sqrt(v);
      const direction = s.toWorld(
        s.vec3(s.mul(s.cos(turn), r), s.mul(s.sin(turn), r), s.sqrt(s.sub(1, v))),
        frame,
        normal,
      );
      const hit = g.traceRay({
        origin,
        direction,
        tMax: radius,
        mask: RayMasks.shadow,
        mode: 'any',
        alphaTest: true,
      });
      return s.add(sum, s.select(0, 1, g.call('ray.hit', { hit })));
    },
    { label: 'hidden' },
  );
  const open = s.select(
    1,
    s.sub(1, s.mul(hidden, 1 / samples)),
    s.greater(position.swizzle('w'), 0.5),
  );
  g.fullscreen({ color: s.vec4(open, open, open, 1) });
  return g.build();
}

// A blur of the openness over 5 × 5 pixels, with the neighbors on the same
// surface only (close normals and positions): the noise of the spirals
// averaged, the edges kept.
function blurGraph(): MaterialGraphData {
  const g = new GraphBuilder('ray occlusion blur');
  const s = new Shading(g);
  const { pixel, load } = pixelOf(g, s);
  const radius = g.uniform('radius', BuiltinTypes.f32, { default: 1 });
  const center = load('position');
  const normal = load('normal').swizzle('xyz');
  let sum: PortHandle | undefined;
  let total: PortHandle | undefined;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const at = s.add(pixel, g.constant(BuiltinTypes.vec2i, [dx, dy]));
      const value = g
        .call('std.textureLoad', {
          texture: g.texture('occlusion'),
          coords: at,
        })
        .swizzle('x');
      const near = s.length(s.sub(load('position', at).swizzle('xyz'), center.swizzle('xyz')));
      const weight = s.mul(
        s.pow(s.max(s.dot(load('normal', at).swizzle('xyz'), normal), 0), 8),
        s.saturate(s.sub(1, s.div(near, s.mul(radius, 0.5)))),
      );
      sum = sum ? s.add(sum, s.mul(value, weight)) : s.mul(value, weight);
      total = total ? s.add(total, weight) : weight;
    }
  }
  const open = s.div(sum as PortHandle, s.max(total as PortHandle, 1e-4));
  g.fullscreen({ color: s.vec4(open, open, open, 1) });
  return g.build();
}

/**
 * Ambient occlusion by rays: for each pixel of a G-buffer, rays in the half
 * sphere of its normal; the share that reaches the radius without a hit is
 * how open the point is to the sky, blurred. Full screen passes, the rays
 * traced in their fragment shaders (rayQuery capability).
 */
export class RayOcclusion {
  readonly renderer: Renderer;
  readonly scene: RayScene;
  readonly radius: number;
  private readonly _occlusion: Material;
  private readonly _blur: Material;

  constructor(
    renderer: Renderer,
    scene: RayScene,
    { radius = 1, samples = 4 }: RayOcclusionOptions = {},
  ) {
    this.renderer = renderer;
    this.scene = scene;
    this.radius = radius;
    this._occlusion = new Material({
      graph: occlusionGraph(Math.max(1, Math.round(samples))),
      values: { radius },
      label: 'ray occlusion',
    });
    this._blur = new Material({
      graph: blurGraph(),
      values: { radius },
      label: 'ray occlusion blur',
    });
  }

  /**
   * Adds the passes to a graph, after those writing the G-buffer: returns
   * the openness of the pixels (r, rgba8unorm), 1 open, 0 hidden.
   */
  addPasses(
    graph: RenderGraph,
    { position, normal }: RayGBuffer,
    name = 'ray occlusion',
  ): TextureHandle {
    const size = graph.textureSize(position);
    const texture = (suffix: string) =>
      graph.createTexture(`${name} ${suffix}`, {
        format: 'rgba8unorm',
        ...(size ? { size } : {}),
      });
    const raw = this.renderer.addFullscreenPass(graph, name, {
      material: this._occlusion,
      inputs: { position, normal },
      target: texture('raw'),
      format: 'rgba8unorm',
      rays: this.scene,
    });
    return this.renderer.addFullscreenPass(graph, `${name} blur`, {
      material: this._blur,
      inputs: { position, normal, occlusion: raw },
      target: texture('blurred'),
      format: 'rgba8unorm',
    });
  }
}
