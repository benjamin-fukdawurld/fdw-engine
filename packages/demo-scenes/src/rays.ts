import type { RenderBackend } from '@fdw/engine-backend';
import {
  BaseLight,
  RenderGraph,
  Renderer,
  RenderOptions,
} from '@fdw/engine-core';
import {
  PathTracer,
  PathTracerSky,
  RayReflections,
  RayScene,
  reflectionOutputs,
} from '@fdw/engine-raytracing';

/**
 * How a demo draws its frames: rasterized, with shadows traced by rays,
 * with traced reflections too, or all by rays (the path tracer).
 */
export type RayMode = 'raster' | 'shadows' | 'reflections' | 'path';

export const RayModes: readonly RayMode[] = [
  'raster',
  'shadows',
  'reflections',
  'path',
];

/**
 * The frames of a demo, in one of the modes of ray tracing (where the
 * backend traces rays: rayQuery), else rasterized. The traced scene is
 * updated from the source of each frame.
 */
export class RayView {
  readonly available: boolean;
  private _mode: RayMode = 'raster';
  private _scene?: RayScene;
  private _reflections?: RayReflections;
  private _tracer?: PathTracer;

  constructor(
    readonly renderer: Renderer,
    backend: RenderBackend,
    private readonly options: {
      readonly sky?: PathTracerSky;
      // The ray tracing pipelines, where the backend has them.
      readonly rayTracingPipeline?: boolean;
    } = {},
  ) {
    this.available = backend.capabilities?.rayQuery === true;
  }

  get mode(): RayMode {
    return this._mode;
  }

  set mode(mode: RayMode) {
    this._mode = this.available ? mode : 'raster';
  }

  /** The next mode (the key T of the demos). */
  cycle(): RayMode {
    this.mode = RayModes[(RayModes.indexOf(this._mode) + 1) % RayModes.length];
    return this._mode;
  }

  /** What the frame line of the demos says of the mode. */
  get label(): string {
    return this._mode === 'path'
      ? `path traced (${this._tracer?.frames ?? 0} frames)`
      : this._mode === 'raster'
        ? 'rasterized'
        : `rays: ${this._mode}`;
  }

  /** Renders a frame, as Renderer.render, in the mode of the view. */
  render(options: RenderOptions): void {
    if (this._mode === 'raster') {
      this.renderer.render(options);
      return;
    }
    // What the frame computes first (the skinning) runs before the update
    // of the traced scene: its structures refit to the vertices of this
    // frame.
    const { prepare: first, ...rest } = options;
    if (first) {
      const graph = new RenderGraph({ size: { width: 1, height: 1 } });
      first(graph);
      this.renderer.executeGraph(graph);
      options = rest;
    }
    const scene = (this._scene ??= new RayScene(this.renderer.backend, {
      registry: this.renderer.registry,
    }));
    scene.update({
      ...(options.source ? { source: options.source } : {}),
      ...(options.items ? { items: options.items } : {}),
      ...(options.layers !== undefined ? { layers: options.layers } : {}),
    });
    const lights: readonly BaseLight[] = options.lights ?? [
      ...(options.source?.lights?.() ?? []),
    ];
    // The sky of the rays: that of the view, else the background of the
    // frame (what the rasterization shows there; sRGB to linear).
    const clear = options.clearColor;
    const linear = (c: number) => Math.pow(c, 2.2);
    const background = clear && {
      x: linear(clear.r),
      y: linear(clear.g),
      z: linear(clear.b),
    };
    const sky: PathTracerSky | undefined =
      this.options.sky ??
      (background && {
        zenith: background,
        horizon: background,
        ground: {
          x: background.x * 0.4,
          y: background.y * 0.4,
          z: background.z * 0.4,
        },
      });
    if (this._mode === 'path') {
      this._tracer ??= new PathTracer(this.renderer, scene, {
        rayTracingPipeline: this.options.rayTracingPipeline ?? false,
      });
      if (sky) {
        this._tracer.sky = { ...this._tracer.sky, ...sky };
      }
      this._tracer.render({
        camera: options.camera,
        surface: options.surface,
        lights,
        ...(options.time !== undefined ? { time: options.time } : {}),
        ...(options.exposure !== undefined
          ? { exposure: options.exposure }
          : {}),
      });
      return;
    }
    const rays = { scene, shadows: true };
    if (this._mode === 'shadows') {
      this.renderer.render({ ...options, rays });
      return;
    }
    // The reflections: the scene passes write a G-buffer besides the
    // image, the reflections are added, then the tone mapping.
    const { surface, prepare, ...scenePasses } = options;
    const current = surface.getCurrentTarget();
    const size = { width: current.width, height: current.height };
    const graph = new RenderGraph({ size });
    prepare?.(graph);
    const passes = this.renderer.addScenePasses(graph, {
      ...scenePasses,
      rays,
      target: graph.createTexture('hdr', { format: 'rgba16float' }),
      format: 'rgba16float',
      linear: true,
      samples: 1,
      outputs: reflectionOutputs(),
      // The occlusion culling reads a depth of one sample: kept.
    });
    this._reflections ??= new RayReflections(this.renderer, scene, {
      rayTracingPipeline: this.options.rayTracingPipeline ?? false,
    });
    if (sky) {
      this._reflections.sky = { ...this._reflections.sky, ...sky };
    }
    const image = this._reflections.addPasses(graph, {
      camera: options.camera,
      lights,
      color: passes.color,
      position: passes.outputs.position,
      normal: passes.outputs.normal,
      baseColor: passes.outputs.baseColor,
    });
    this.renderer.addToneMappingPass(graph, {
      hdr: image,
      target: graph.importTexture('surface', current),
      format: surface.format,
    });
    this.renderer.executeGraph(graph);
    surface.present();
  }

  destroy(): void {
    this._tracer?.destroy();
    this._reflections?.destroy();
    this._scene?.destroy();
  }
}
