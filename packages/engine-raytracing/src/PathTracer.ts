import {
  CameraCache,
  GpuBuffer,
  GpuSampler,
  GpuTexture,
  IVec3,
  RenderBackend,
  Surface,
} from '@fdw/engine-backend';
import {
  BaseLight,
  Camera,
  ComputeRunner,
  DirectionalLight,
  Environment,
  LightPoolStride,
  Material,
  MaterialValue,
  PointLight,
  RenderGraph,
  Renderer,
  SpotLight,
  TextureHandle,
  writeLightPool,
} from '@fdw/engine-core';
import {
  compile,
  CompiledProgram,
  MaterialGraphData,
  RaySurfaceVec4s,
} from '@fdw/engine-shader';
import { MaterialHits, sceneValues } from './MaterialHits';
import {
  accumulateKernel,
  bounceKernel,
  cameraKernel,
  denoiseKernel,
  GuideVec4s,
  guidesKernel,
  PathVec4s,
  presentGraph,
  traceKernel,
} from './kernels';
import type { RayScene } from './RayScene';

/** The sky of the path tracer: a gradient, what the rays lost see. */
export interface PathTracerSky {
  readonly zenith?: IVec3;
  readonly horizon?: IVec3;
  readonly ground?: IVec3;
}

export interface PathTracerOptions {
  /** Bounces of the paths after the first hit (default 4, at most 16). */
  readonly bounces?: number;
  /**
   * The à-trous filter on the image (default true): its passes (5), and
   * how much it blurs across colors (colorPhi, 4); it stops after
   * `frames` frames gathered (256), when the noise is gone.
   */
  readonly denoise?:
    | boolean
    | {
        readonly iterations?: number;
        readonly colorPhi?: number;
        readonly frames?: number;
      };
  /** The brightest a sample can be (luminance), against fireflies (8). */
  readonly maxRadiance?: number;
  /**
   * The frames a pixel keeps of its history while the camera or the scene
   * moves (default 16): fewer, less blur and more noise in motion. Still,
   * the frames add up without end.
   */
  readonly history?: number;
  /**
   * The kernels tracing rays as ray tracing pipelines where the backend has
   * them (rayTracingPipeline capability: Vulkan), the ray queries otherwise
   * (default false: the ray queries everywhere).
   */
  readonly rayTracingPipeline?: boolean;
  readonly sky?: PathTracerSky;
}

export interface PathTraceOptions {
  readonly camera: Camera;
  /** The lights of the scene (directional, point and spot lights). */
  readonly lights?: readonly BaseLight[];
  /** The size of the image, in pixels. */
  readonly width: number;
  readonly height: number;
  /** Seconds, the engine time of the materials. */
  readonly time?: number;
  /**
   * What the rays lost see: the panorama of an environment, instead of
   * the gradient of the sky (see PathTracerOptions.sky).
   */
  readonly environment?: Environment;
}

// A compiled kernel.
interface Kernel {
  readonly program: CompiledProgram;
}

// The buffers of an image of width × height pixels.
interface Buffers {
  readonly width: number;
  readonly height: number;
  readonly paths: [GpuBuffer, GpuBuffer];
  readonly hits: GpuBuffer;
  readonly surfaces: GpuBuffer;
  readonly guides: [GpuBuffer, GpuBuffer];
  readonly accumulation: [GpuBuffer, GpuBuffer];
  readonly color: GpuBuffer;
  readonly filtered: [GpuBuffer, GpuBuffer];
}

const Workgroup = 64;

// The 1 × 1 panorama bound without environment, by backend.
const noPanoramas = new WeakMap<
  RenderBackend,
  { texture: GpuTexture; sampler: GpuSampler }
>();

/**
 * The values of the sky of the kernels (see skyRadiance): the panorama of
 * an environment (prefiltered by the renderer when it changed), or the
 * gradient of a sky.
 */
export function skyValues(
  renderer: Renderer,
  sky: Required<PathTracerSky>,
  environment: Environment | undefined,
): Record<string, MaterialValue> {
  const backend = renderer.backend;
  let none = noPanoramas.get(backend);
  if (!none) {
    none = {
      texture: backend.textures.createTexture({
        label: 'no sky panorama',
        type: '2d',
        format: 'rgba8unorm',
        dimensions: { width: 1, height: 1 },
        source: new Uint8Array(4),
      }),
      sampler: backend.textures.createSampler({
        minFilter: 'linear',
        magFilter: 'linear',
        mipmapFilter: 'nearest',
        wrapModeS: 'repeat',
        wrapModeT: 'clamp-to-edge',
      }),
    };
    noPanoramas.set(backend, none);
  }
  return {
    skyZenith: vec3(sky.zenith),
    skyHorizon: vec3(sky.horizon),
    skyGround: vec3(sky.ground),
    skyIntensity: environment?.intensity ?? 0,
    skyPanorama: environment
      ? renderer.environmentTextures(environment).panorama
      : none.texture,
    skyPanoramaSampler: none.sampler,
  };
}

// The lights the kernels light with: directional, point and spot lights.
const isSupported = (light: BaseLight) =>
  light instanceof DirectionalLight ||
  light instanceof PointLight ||
  light instanceof SpotLight;

/** The lights packLights packs: directional, point and spot lights. */
export const countLights = (lights: readonly BaseLight[]): number =>
  lights.filter(isSupported).length;

/**
 * Packs lights for the kernels: the directional, point and spot lights, in
 * a light pool, the format of the renderer's (writeLightPool, and
 * lightMembers in engine-shader: LightVec4s vec4 each).
 */
export function packLights(
  lights: readonly BaseLight[],
): Float32Array<ArrayBuffer> {
  const supported = lights.filter(isSupported);
  return writeLightPool(supported).slice(
    0,
    Math.max(1, supported.length) * LightPoolStride,
  );
}

/**
 * A path tracer: the whole image by rays and bounces, against a RayScene,
 * in compute passes (on the backends with the rayQuery capability). In
 * waves: the rays of all the pixels are traced, the surfaces hit are
 * evaluated by the hit programs of their materials (the same graphs as
 * the rasterization, compiled for the points hit), then a bounce kernel
 * gathers their emission and the light of a light chosen at random, and
 * samples the next directions. The frames add up while the camera and the
 * scene do not change; when they move, each pixel follows the point it
 * sees (its history reprojected, a few frames long); an à-trous filter
 * removes the noise of the first frames.
 */
export class PathTracer {
  readonly renderer: Renderer;
  readonly scene: RayScene;
  private readonly _runner: ComputeRunner;
  private readonly _kernels: Record<
    'camera' | 'trace' | 'guides' | 'bounce' | 'accumulate' | 'denoise',
    Kernel
  >;
  private readonly _hits: MaterialHits;
  private readonly _present: Material;
  private _buffers?: Buffers;
  private _lightBuffer?: GpuBuffer;
  private _frame = 0;
  private _frames = 0;
  private _accumulated = 0;
  private _signature = '';
  // What the frames of the history depend on, besides the lighting.
  private _view = '';
  private _revision = -1;
  private _previousViewProjection = new Float32Array(16);
  private readonly _cameras = new WeakMap<Camera, CameraCache>();
  private readonly _environmentIds = new Map<Environment, number>();
  // The owners of the dispatches with their own uniforms.
  private readonly _owners = Array.from({ length: 64 }, () => ({}));
  readonly bounces: number;
  readonly maxRadiance: number;
  readonly history: number;
  readonly denoise:
    { iterations: number; colorPhi: number; frames: number } | undefined;
  sky: Required<PathTracerSky>;

  constructor(
    renderer: Renderer,
    scene: RayScene,
    options: PathTracerOptions = {},
  ) {
    this.renderer = renderer;
    this.scene = scene;
    if (!renderer.backend.capabilities?.rayQuery) {
      throw new Error('The backend traces no rays (rayQuery capability)');
    }
    // Room for the groups of a frame: a few per material and bounce.
    this._runner = new ComputeRunner(renderer.backend, {
      bindGroups: 4096,
      rayTracing: options.rayTracingPipeline ?? false,
    });
    this._hits = new MaterialHits(renderer.backend, renderer.registry);
    const capabilities = renderer.backend.capabilities;
    const kernel = (graph: MaterialGraphData): Kernel => ({
      program: compile(graph, { capabilities }),
    });
    this._kernels = {
      camera: kernel(cameraKernel()),
      trace: kernel(traceKernel()),
      guides: kernel(guidesKernel()),
      bounce: kernel(bounceKernel()),
      accumulate: kernel(accumulateKernel()),
      denoise: kernel(denoiseKernel()),
    };
    this._present = new Material({
      graph: presentGraph(),
      label: 'path tracer',
    });
    this.bounces = Math.min(16, Math.max(1, options.bounces ?? 4));
    this.maxRadiance = options.maxRadiance ?? 8;
    this.history = Math.max(1, options.history ?? 16);
    const denoise = options.denoise ?? true;
    this.denoise = denoise
      ? {
          iterations: (denoise === true ? undefined : denoise.iterations) ?? 5,
          colorPhi: (denoise === true ? undefined : denoise.colorPhi) ?? 4,
          frames: (denoise === true ? undefined : denoise.frames) ?? 256,
        }
      : undefined;
    this.sky = {
      zenith: options.sky?.zenith ?? { x: 0.35, y: 0.55, z: 0.9 },
      horizon: options.sky?.horizon ?? { x: 0.8, y: 0.85, z: 0.9 },
      ground: options.sky?.ground ?? { x: 0.25, y: 0.22, z: 0.2 },
    };
  }

  /**
   * The frames gathered in the image since the last change (of the
   * camera, the scene, the lights or the materials).
   */
  get frames(): number {
    return this._accumulated;
  }

  /** Starts gathering again at the next frame, without history. */
  reset(): void {
    this._signature = '';
  }

  /**
   * Traces a frame of the scene (updated before), gathered with the
   * previous ones: all of them while the camera and the scene do not move,
   * the last ones (`history`) of the points seen otherwise; none when the
   * lights or the materials change. The image is in `color`, a vec4 per
   * pixel, rows from the top.
   */
  trace({
    camera,
    lights = [],
    width,
    height,
    time = 0,
    environment,
  }: PathTraceOptions): GpuBuffer {
    const backend = this.renderer.backend;
    const buffers = this.buffers(width, height);
    const pixels = width * height;
    const groups = [Math.ceil(pixels / Workgroup)] as const;
    const cache = this.cameraCache(camera);
    const lightData = packLights(lights);
    const viewProjection = cache.viewProjectionMatrix.value;
    const signature = [
      ...this.scene.materials.map((material) => material.version),
      ...lightData,
      width,
      height,
      this.environmentKey(environment),
    ].join(',');
    const reset = signature !== this._signature;
    this._signature = signature;
    const view = viewProjection.join(',');
    const still = !reset && view === this._view;
    const moved = !still || this.scene.revision !== this._revision;
    this._view = view;
    this._revision = this.scene.revision;
    this._accumulated = moved ? 1 : this._accumulated + 1;
    this._frame++;
    const lightBuffer = this.lightBuffer(lightData);
    // The guides and the accumulation of this frame, and of the previous.
    const [previous, current] = this._frames % 2 === 0 ? [0, 1] : [1, 0];
    const lightCount = countLights(lights);
    const sky = skyValues(this.renderer, this.sky, environment);

    const encoder = backend.createCommandEncoder();
    const pass = encoder.beginComputePass('path tracer');
    // The dispatches with uniforms of their own have their own owner: the
    // kernels, each bounce, each pass of the filter, each material.
    const dispatch = (
      program: CompiledProgram,
      values: Record<string, MaterialValue>,
      owner: object,
    ) => {
      this._runner.record(pass, program, {
        values: { pixelCount: pixels, ...values },
        workgroups: groups,
        owner,
      });
    };
    const owners = this._owners;
    const frameValues = {
      viewProjection: cache.viewProjectionMatrix.value,
      view: cache.viewMatrix.value,
      projection: cache.projectionMatrix.value,
      inverseViewProjection: cache.inverseViewProjectionMatrix.value,
      cameraPosition: [camera.position.x, camera.position.y, camera.position.z],
      time,
      exposure: 1,
    };
    const scene = this.scene;
    const resources = sceneValues(scene);

    dispatch(
      this._kernels.camera.program,
      {
        width,
        height,
        frame: this._frame,
        inverseViewProjection: cache.inverseViewProjectionMatrix.value,
        pathsOut: buffers.paths[0],
      },
      owners[0],
    );
    for (let bounce = 0; bounce <= this.bounces; bounce++) {
      const [a, b] = [bounce % 2, (bounce + 1) % 2];
      dispatch(
        this._kernels.trace.program,
        {
          ...resources,
          rays: buffers.paths[a],
          stride: PathVec4s,
          rayHits: buffers.hits,
          raySurfaces: buffers.surfaces,
        },
        owners[1],
      );
      this._hits.forEach(
        scene,
        {
          hits: buffers.hits,
          surfaces: buffers.surfaces,
          count: pixels,
          frame: frameValues,
        },
        dispatch,
      );
      if (bounce === 0) {
        dispatch(
          this._kernels.guides.program,
          {
            ...sky,
            paths: buffers.paths[a],
            raySurfaces: buffers.surfaces,
            guides: buffers.guides[current],
          },
          owners[3],
        );
      }
      dispatch(
        this._kernels.bounce.program,
        {
          ...resources,
          frame: this._frame,
          bounce,
          lightCount,
          lights: lightBuffer,
          ...sky,
          paths: buffers.paths[a],
          raySurfaces: buffers.surfaces,
          pathsOut: buffers.paths[b],
        },
        owners[4 + bounce],
      );
    }
    const last = (this.bounces + 1) % 2;
    this._frames++;
    dispatch(
      this._kernels.accumulate.program,
      {
        width,
        height,
        reset: reset ? 1 : 0,
        still: still ? 1 : 0,
        maxHistory: moved ? this.history : 1e9,
        previousViewProjection: this._previousViewProjection,
        maxRadiance: this.maxRadiance,
        paths: buffers.paths[last],
        guides: buffers.guides[current],
        previousGuides: buffers.guides[previous],
        accumulation: buffers.accumulation[previous],
        accumulationOut: buffers.accumulation[current],
        color: buffers.color,
      },
      owners[2],
    );
    this._previousViewProjection.set(viewProjection);
    let image = buffers.color;
    const denoise = this.denoise;
    if (denoise && this._accumulated < denoise.frames) {
      for (let i = 0; i < denoise.iterations; i++) {
        const output = buffers.filtered[i % 2];
        dispatch(
          this._kernels.denoise.program,
          {
            width,
            height,
            step: 1 << i,
            colorPhi: denoise.colorPhi,
            first: i === 0 ? 1 : 0,
            last: i === denoise.iterations - 1 ? 1 : 0,
            input: image,
            guides: buffers.guides[current],
            accumulation: buffers.accumulation[current],
            output,
          },
          owners[3 + 32 + i],
        );
        image = output;
      }
    }
    pass.end();
    backend.submit([encoder.finish()]);
    return image;
  }

  /**
   * Adds the image of a frame to a graph: traced now (see trace), drawn
   * into `target` in linear colors (an HDR texture, for the tone mapping).
   */
  addPasses(
    graph: RenderGraph,
    options: Omit<PathTraceOptions, 'width' | 'height'> & {
      readonly target: TextureHandle;
      readonly format: 'rgba16float' | 'rgba32float';
    },
  ): TextureHandle {
    const size = graph.pixelSize(options.target);
    if (!size) {
      throw new Error('The target of the path tracer needs a size in pixels');
    }
    const { width, height } = size;
    const image = this.trace({ ...options, width, height });
    this._present.setValue('color', image);
    this._present.setValue('width', width);
    this._present.setValue('height', height);
    return this.renderer.addFullscreenPass(graph, 'path tracer', {
      material: this._present,
      target: options.target,
      format: options.format,
    });
  }

  /**
   * Renders a frame to a surface: traced, tone mapped and encoded as the
   * renderer does (its `output`), presented.
   */
  render({
    surface,
    exposure,
    ...options
  }: Omit<PathTraceOptions, 'width' | 'height'> & {
    readonly surface: Surface;
    readonly exposure?: number;
  }): void {
    const current = surface.getCurrentTarget();
    const size = { width: current.width, height: current.height };
    const graph = new RenderGraph({ size });
    const target = graph.importTexture('surface', current);
    const hdr = graph.createTexture('path tracer hdr', {
      format: 'rgba16float',
      size,
    });
    const image = this.addPasses(graph, {
      ...options,
      target: hdr,
      format: 'rgba16float',
    });
    this.renderer.addToneMappingPass(graph, {
      hdr: image,
      target,
      format: surface.format,
      exposure: exposure ?? 1,
    });
    this.renderer.executeGraph(graph);
    surface.present();
  }

  destroy(): void {
    this._runner.destroy();
    this.freeBuffers();
    this._lightBuffer?.destroy();
  }

  // What the history depends on of an environment: which one, its version
  // and intensity.
  private environmentKey(environment: Environment | undefined): string {
    if (!environment) {
      return '';
    }
    let id = this._environmentIds.get(environment);
    if (id === undefined) {
      id = this._environmentIds.size + 1;
      this._environmentIds.set(environment, id);
    }
    return `${id}:${environment.version}:${environment.intensity}`;
  }

  private cameraCache(camera: Camera): CameraCache {
    let cache = this._cameras.get(camera);
    if (!cache) {
      cache = new CameraCache(camera, this.renderer.backend.cameraMath);
      this._cameras.set(camera, cache);
    }
    return cache;
  }

  private lightBuffer(data: Float32Array<ArrayBuffer>): GpuBuffer {
    if (!this._lightBuffer || this._lightBuffer.size < data.byteLength) {
      this._lightBuffer?.destroy();
      this._lightBuffer = this.renderer.backend.buffers.create({
        label: 'path tracer lights',
        size: Math.max(data.byteLength, 16 * LightPoolStride * 4),
        usage: ['storage', 'copy-dst'],
      });
    }
    this._lightBuffer.write(0, data.buffer, data.byteOffset, data.byteLength);
    return this._lightBuffer;
  }

  private buffers(width: number, height: number): Buffers {
    const current = this._buffers;
    if (current && current.width === width && current.height === height) {
      return current;
    }
    this.freeBuffers();
    const pixels = width * height;
    const create = (vec4s: number, label: string) =>
      this.renderer.backend.buffers.create({
        label: `path tracer ${label}`,
        size: Math.max(1, pixels * vec4s) * 16,
        usage: ['storage', 'copy-dst', 'copy-src'],
      });
    const pair = (vec4s: number, label: string): [GpuBuffer, GpuBuffer] => [
      create(vec4s, label),
      create(vec4s, label),
    ];
    this._buffers = {
      width,
      height,
      paths: pair(PathVec4s, 'paths'),
      hits: create(1, 'hits'),
      surfaces: create(RaySurfaceVec4s, 'surfaces'),
      guides: pair(GuideVec4s, 'guides'),
      accumulation: pair(1, 'accumulation'),
      color: create(1, 'color'),
      filtered: pair(1, 'filtered'),
    };
    this._signature = '';
    return this._buffers;
  }

  private freeBuffers(): void {
    const buffers = this._buffers;
    if (!buffers) {
      return;
    }
    for (const value of Object.values(buffers)) {
      const list = Array.isArray(value) ? value : [value];
      for (const buffer of list) {
        if (typeof buffer === 'object') {
          (buffer as GpuBuffer).destroy();
        }
      }
    }
    this._buffers = undefined;
  }
}

const vec3 = (value: IVec3) => [value.x, value.y, value.z];
