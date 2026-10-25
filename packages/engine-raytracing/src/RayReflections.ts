import type { GpuBuffer, IVec3 } from '@fdw/engine-backend';
import {
  BaseLight,
  Camera,
  ComputeRunner,
  Material,
  MaterialValue,
  RenderGraph,
  Renderer,
  SceneOutput,
  TextureHandle,
} from '@fdw/engine-core';
import {
  arrayType,
  BuiltinTypes,
  compile,
  CompiledProgram,
  defineFunction,
  GraphBuilder,
  MaterialGraphData,
  RayMasks,
  RaySurfaceVec4s,
  stdRays,
} from '@fdw/engine-shader';
import { LightVec4s, traceKernel } from './kernels';
import { MaterialHits, sceneValues } from './MaterialHits';
import { countLights, packLights, PathTracerSky } from './PathTracer';
import type { RayGBuffer } from './RayOcclusion';
import type { RayScene } from './RayScene';
import { Bsdf, Shading } from './shading';

/**
 * What the reflections read of each pixel (see reflectionOutputs): its
 * point, its normal with the roughness in w, its base color with the
 * metalness in w; and the lit image.
 */
export interface RayReflectionsGBuffer extends RayGBuffer {
  /** The lit image (linear colors), the reflections are added to. */
  readonly color: TextureHandle;
  /** The base color of the surfaces, the metalness in w. */
  readonly baseColor: TextureHandle;
}

export interface RayReflectionsOptions {
  /** The roughest surfaces that reflect (0.5); they fade out up to it. */
  readonly maxRoughness?: number;
  /** What the reflections that hit nothing see. */
  readonly sky?: PathTracerSky;
  /** The ambient light of the points reflected (the sky by default). */
  readonly ambient?: IVec3;
}

const vec4f = arrayType(BuiltinTypes.vec4f);

// The pixel of the thread, and its texels.
function pixelThread(g: GraphBuilder, s: Shading) {
  const index = g.builtin('global-invocation-id').swizzle('x');
  const width = g.uniform('width', BuiltinTypes.u32);
  const count = g.uniform('pixelCount', BuiltinTypes.u32);
  const pixel = s.convert(
    g.call('std.uvec2', { x: s.remainder(index, width), y: s.div(index, width) }),
    BuiltinTypes.vec2i,
  );
  const load = (name: string) =>
    g.call('std.textureLoad', { texture: g.texture(name), coords: pixel });
  const finish = () => {
    g.compute({ workgroupSize: [64, 1, 1], active: s.less(index, count) });
    return g.build();
  };
  return { index, width, load, finish };
}

// The reflected ray of each pixel: from its point, the view direction
// mirrored by its normal; alive on the surfaces smooth enough.
function reflectionRaysKernel(): MaterialGraphData {
  const g = new GraphBuilder('reflection rays');
  const s = new Shading(g);
  const { index, load, finish } = pixelThread(g, s);
  const eye = g.uniform('eye', BuiltinTypes.vec3f);
  const maxRoughness = g.uniform('maxRoughness', BuiltinTypes.f32);
  const position = load('position');
  const normal = s.normalize(load('normal').swizzle('xyz'));
  const roughness = load('normal').swizzle('w');
  const view = s.normalize(s.sub(position.swizzle('xyz'), eye));
  const direction = s.reflect(view, normal);
  const alive = s.and(
    s.greater(position.swizzle('w'), 0.5),
    s.less(roughness, maxRoughness),
  );
  const rays = g.storage('raysOut', vec4f, { access: 'read-write' });
  g.write(rays, {
    index: s.mul(index, s.u32(2)),
    value: s.extend(
      s.add(position.swizzle('xyz'), s.mul(normal, 1e-3)),
      s.select(0, 1, alive),
    ),
  });
  g.write(rays, {
    index: s.add(s.mul(index, s.u32(2)), s.u32(1)),
    value: s.extend(direction, 0),
  });
  return finish();
}

// The light of the points the reflected rays hit: their emission, every
// light (a shadow ray each), the ambient light; the sky for the rays that
// hit nothing.
function shadeKernel(): MaterialGraphData {
  const g = new GraphBuilder('shade reflections');
  const s = new Shading(g);
  const index = g.builtin('global-invocation-id').swizzle('x');
  const count = g.uniform('pixelCount', BuiltinTypes.u32);
  const lightCount = g.uniform('lightCount', BuiltinTypes.u32);
  const ambient = g.uniform('ambient', BuiltinTypes.vec3f);
  const zenith = g.uniform('skyZenith', BuiltinTypes.vec3f);
  const horizon = g.uniform('skyHorizon', BuiltinTypes.vec3f);
  const ground = g.uniform('skyGround', BuiltinTypes.vec3f);
  const rays = g.storage('rays', vec4f);
  const lights = g.storage('lights', vec4f);
  const surfaces = g.storage('raySurfaces', vec4f);
  const hit = s.index(g.storage('rayHits', arrayType(BuiltinTypes.vec4u)), index);
  const alive = s.greater(s.index(rays, s.mul(index, s.u32(2))).swizzle('w'), 0.5);
  const dir = s.normalize(
    s.index(rays, s.add(s.mul(index, s.u32(2)), s.u32(1))).swizzle('xyz'),
  );
  const surface = (k: number) =>
    s.index(surfaces, s.add(s.mul(index, s.u32(RaySurfaceVec4s)), s.u32(k)));
  const [s0, s1, s2, s3, s4] = [0, 1, 2, 3, 4].map(surface);
  const normal = s.normalize(s1.swizzle('xyz'));
  // Written by the hit program: the geometry of the scene is not read.
  const position = s4.swizzle('xyz');
  const bsdf = new Bsdf(
    s,
    {
      baseColor: s0.swizzle('xyz'),
      normal,
      roughness: s.clamp(s1.swizzle('w'), 0.02, 1),
      metallic: s.saturate(s2.swizzle('w')),
    },
    s.mul(dir, -1),
  );
  const origin = s.add(position, s.mul(normal, 1e-3));
  // The lights, one by one.
  const direct = g.fold([0, 0, 0], lightCount, (sum, k) => {
    const light = (j: number) =>
      s.index(lights, s.add(s.mul(k, s.u32(LightVec4s)), s.u32(j)));
    const [l0, l1, l2, l3] = [0, 1, 2, 3].map(light);
    const toLight = s.sub(l0.swizzle('xyz'), s.mul(position, l0.swizzle('w')));
    const distance = s.length(toLight);
    const l = s.div(toLight, s.max(distance, 1e-6));
    const positional = s.greater(l0.swizzle('w'), 0.5);
    const attenuation = s.select(
      1,
      s.div(
        1,
        s.max(
          s.sum([
            l3.swizzle('x'),
            s.mul(l3.swizzle('y'), distance),
            s.mul(l3.swizzle('z'), s.mul(distance, distance)),
          ]),
          1e-6,
        ),
      ),
      positional,
    );
    const spot = s.saturate(
      s.div(
        s.sub(s.dot(s.mul(l, -1), l2.swizzle('xyz')), l3.swizzle('w')),
        s.max(s.sub(l2.swizzle('w'), l3.swizzle('w')), 1e-4),
      ),
    );
    const facing = s.greater(s.dot(normal, l), 0);
    const shadow = g.traceRay({
      origin,
      direction: s.sub(s.add(position, toLight), origin),
      tMax: s.select(-1, s.select(1e30, 0.999, positional), facing),
      mask: RayMasks.shadow,
      mode: 'any',
    });
    const visible = s.and(facing, s.not(g.call(stdRays.hit, { hit: shadow })));
    return s.add(
      sum,
      s.select(
        [0, 0, 0],
        s.mul(bsdf.evaluate(l), s.mul(l1.swizzle('xyz'), s.mul(attenuation, spot))),
        visible,
      ),
    );
  });
  const unlit = s.greater(s3.swizzle('y'), 0.5);
  const lit = s.sum([
    s2.swizzle('xyz'),
    s.select(
      s.add(direct, s.mul(s.mul(ambient, bsdf.diffuse), s3.swizzle('x'))),
      [0, 0, 0],
      unlit,
    ),
  ]);
  const up = dir.swizzle('y');
  const sky = s.select(
    s.mix(horizon, ground, s.saturate(s.mul(up, -4))),
    s.mix(horizon, zenith, s.saturate(up)),
    s.greater(up, 0),
  );
  const color = s.select(sky, lit, g.call(stdRays.hit, { hit }));
  g.write(g.storage('reflections', vec4f, { access: 'read-write' }), {
    index,
    value: s.extend(s.select([0, 0, 0], color, alive), s.select(0, 1, alive)),
  });
  g.compute({ workgroupSize: [64, 1, 1], active: s.less(index, count) });
  return g.build();
}

// The image with its reflections: the color of each pixel plus the light
// reflected, weighted by the Fresnel term of the surface and faded out
// with its roughness.
function composeGraph(): MaterialGraphData {
  const g = new GraphBuilder('compose reflections');
  const s = new Shading(g);
  const pixel = s.convert(g.builtin('frag-coord').swizzle('xy'), BuiltinTypes.vec2i);
  const load = (name: string) =>
    g.call('std.textureLoad', { texture: g.texture(name), coords: pixel });
  const width = g.uniform('width', BuiltinTypes.u32);
  const eye = g.uniform('eye', BuiltinTypes.vec3f);
  const maxRoughness = g.uniform('maxRoughness', BuiltinTypes.f32);
  const at = s.convert(pixel, BuiltinTypes.vec2u);
  const reflection = s.index(
    g.storage('reflections', vec4f),
    s.add(s.mul(at.swizzle('y'), width), at.swizzle('x')),
  );
  const color = load('color');
  const position = load('position').swizzle('xyz');
  const normal = s.normalize(load('normal').swizzle('xyz'));
  const roughness = load('normal').swizzle('w');
  const base = load('baseColor');
  const f0 = s.mix(s.splat3(0.04), base.swizzle('xyz'), base.swizzle('w'));
  const cosine = s.saturate(s.dot(normal, s.normalize(s.sub(eye, position))));
  const fresnel = s.add(f0, s.mul(s.sub(s.splat3(1), f0), s.pow(s.sub(1, cosine), 5)));
  const fade = s.saturate(s.sub(1, s.div(roughness, s.max(maxRoughness, 1e-4))));
  const added = s.mul(
    s.mul(reflection.swizzle('xyz'), fresnel),
    s.mul(fade, reflection.swizzle('w')),
  );
  g.fullscreen({ color: s.extend(s.add(color.swizzle('xyz'), added), color.swizzle('w')) });
  return g.build();
}

/**
 * The outputs of the scene passes the reflections read (32 bytes per
 * pixel with an rgba16float color: the most WebGPU allows): the point
 * ('world-position'), the normal with the roughness in w, the base color
 * with the metalness in w (0.5 and 0 for the models without them). Also
 * those of RayOcclusion (position, normal).
 */
export function reflectionOutputs(): {
  position: SceneOutput;
  normal: SceneOutput;
  baseColor: SceneOutput;
} {
  const pack = (id: string, value: string, extra: string) => {
    const f = new GraphBuilder(id);
    const s = new Shading(f);
    f.functionOutput(
      'value',
      s.extend(
        f.functionInput(value, BuiltinTypes.vec3f),
        f.functionInput(extra, BuiltinTypes.f32),
      ),
    );
    return defineFunction(f.build(), { id });
  };
  return {
    position: { format: 'rgba16float', value: 'world-position' },
    normal: {
      format: 'rgba16float',
      value: pack('rays.normalRoughness', 'worldNormal', 'roughness'),
    },
    baseColor: {
      format: 'rgba16float',
      value: pack('rays.baseColorMetallic', 'baseColor', 'metallic'),
    },
  };
}

/**
 * Reflections by rays: from each pixel of a G-buffer, the view direction
 * mirrored by the normal, traced in the scene; the surfaces hit evaluated
 * by the hit programs of their materials, lit by every light (with traced
 * shadows) and the ambient light; added to the image, by the Fresnel term
 * of the surface reflecting, faded out with its roughness. Compute passes
 * (rayQuery capability).
 */
export class RayReflections {
  readonly renderer: Renderer;
  readonly scene: RayScene;
  maxRoughness: number;
  sky: Required<PathTracerSky>;
  ambient?: IVec3;
  private readonly _runner: ComputeRunner;
  private readonly _hits: MaterialHits;
  private readonly _programs: {
    rays: CompiledProgram;
    trace: CompiledProgram;
    shade: CompiledProgram;
  };
  private readonly _compose: Material;
  private _buffers?: {
    pixels: number;
    rays: GpuBuffer;
    hits: GpuBuffer;
    surfaces: GpuBuffer;
    reflections: GpuBuffer;
  };
  private _lights?: GpuBuffer;
  private readonly _owners = Array.from({ length: 4 }, () => ({}));

  constructor(
    renderer: Renderer,
    scene: RayScene,
    { maxRoughness = 0.5, sky, ambient }: RayReflectionsOptions = {},
  ) {
    this.renderer = renderer;
    this.scene = scene;
    this.maxRoughness = maxRoughness;
    this.sky = {
      zenith: sky?.zenith ?? { x: 0.35, y: 0.55, z: 0.9 },
      horizon: sky?.horizon ?? { x: 0.8, y: 0.85, z: 0.9 },
      ground: sky?.ground ?? { x: 0.25, y: 0.22, z: 0.2 },
    };
    if (ambient) {
      this.ambient = ambient;
    }
    // Room for the groups of a frame: a few per material.
    this._runner = new ComputeRunner(renderer.backend, { bindGroups: 1024 });
    this._hits = new MaterialHits(renderer.backend, renderer.registry);
    const capabilities = renderer.backend.capabilities;
    this._programs = {
      rays: compile(reflectionRaysKernel(), { capabilities }),
      trace: compile(traceKernel(), { capabilities }),
      shade: compile(shadeKernel(), { capabilities }),
    };
    this._compose = new Material({
      graph: composeGraph(),
      label: 'reflections',
    });
  }

  /**
   * Adds the passes to a graph, after those writing the G-buffer and the
   * image: returns the image with the reflections (rgba16float).
   */
  addPasses(
    graph: RenderGraph,
    {
      camera,
      lights = [],
      ...gbuffer
    }: RayReflectionsGBuffer & {
      readonly camera: Camera;
      readonly lights?: readonly BaseLight[];
    },
    name = 'reflections',
  ): TextureHandle {
    const size = graph.pixelSize(gbuffer.color);
    if (!size) {
      throw new Error('The image of the reflections needs a size in pixels');
    }
    const { width, height } = size;
    const pixels = width * height;
    const buffers = this.buffers(pixels);
    const lightData = packLights(lights);
    const lightBuffer = this.lightBuffer(lightData);
    const eye = [camera.position.x, camera.position.y, camera.position.z];
    const ambient =
      this.ambient ??
      lights.reduce(
        (sum, light) => ({
          x: sum.x + light.ambient.x,
          y: sum.y + light.ambient.y,
          z: sum.z + light.ambient.z,
        }),
        { x: 0, y: 0, z: 0 },
      );
    const groups = [Math.ceil(pixels / 64)] as const;
    const resources = sceneValues(this.scene);
    graph.addComputePass(`${name} rays`, (pass) => {
      const read = {
        position: pass.read(gbuffer.position, 'sampled'),
        normal: pass.read(gbuffer.normal, 'sampled'),
      };
      pass.hasSideEffects();
      return {
        execute: ({ pass: encoder, texture }) => {
          let owner = 0;
          const dispatch = (
            program: CompiledProgram,
            values: Record<string, MaterialValue>,
          ) =>
            this._runner.record(encoder, program, {
              values: { pixelCount: pixels, width, ...values },
              workgroups: groups,
              owner: this._owners[owner++],
            });
          dispatch(this._programs.rays, {
            eye,
            maxRoughness: this.maxRoughness,
            position: texture(read.position) as MaterialValue,
            normal: texture(read.normal) as MaterialValue,
            raysOut: buffers.rays,
          });
          dispatch(this._programs.trace, {
            ...resources,
            rays: buffers.rays,
            stride: 2,
            rayHits: buffers.hits,
          });
          this._hits.forEach(
            this.scene,
            {
              hits: buffers.hits,
              surfaces: buffers.surfaces,
              count: pixels,
              frame: { cameraPosition: eye },
            },
            (program, values, material) =>
              this._runner.record(encoder, program, {
                values,
                workgroups: groups,
                owner: material,
              }),
          );
          dispatch(this._programs.shade, {
            ...resources,
            lightCount: countLights(lights),
            lights: lightBuffer,
            ambient: [ambient.x, ambient.y, ambient.z],
            skyZenith: vec3(this.sky.zenith),
            skyHorizon: vec3(this.sky.horizon),
            skyGround: vec3(this.sky.ground),
            rays: buffers.rays,
            rayHits: buffers.hits,
            raySurfaces: buffers.surfaces,
            reflections: buffers.reflections,
          });
        },
      };
    });
    this._compose.setValue('reflections', buffers.reflections);
    this._compose.setValue('width', width);
    this._compose.setValue('eye', eye);
    this._compose.setValue('maxRoughness', this.maxRoughness);
    return this.renderer.addFullscreenPass(graph, name, {
      material: this._compose,
      inputs: {
        color: gbuffer.color,
        position: gbuffer.position,
        normal: gbuffer.normal,
        baseColor: gbuffer.baseColor,
      },
      target: graph.createTexture(`${name} image`, {
        format: 'rgba16float',
        size: { width, height },
      }),
      format: 'rgba16float',
    });
  }

  destroy(): void {
    this._runner.destroy();
    const buffers = this._buffers;
    if (buffers) {
      buffers.rays.destroy();
      buffers.hits.destroy();
      buffers.surfaces.destroy();
      buffers.reflections.destroy();
    }
    this._lights?.destroy();
  }

  private buffers(pixels: number) {
    if (this._buffers?.pixels === pixels) {
      return this._buffers;
    }
    this.destroyBuffers();
    const create = (vec4s: number, label: string) =>
      this.renderer.backend.buffers.create({
        label: `reflections ${label}`,
        size: Math.max(1, pixels * vec4s) * 16,
        usage: ['storage', 'copy-dst', 'copy-src'],
      });
    this._buffers = {
      pixels,
      rays: create(2, 'rays'),
      hits: create(1, 'hits'),
      surfaces: create(RaySurfaceVec4s, 'surfaces'),
      reflections: create(1, 'colors'),
    };
    return this._buffers;
  }

  private destroyBuffers(): void {
    const buffers = this._buffers;
    if (buffers) {
      buffers.rays.destroy();
      buffers.hits.destroy();
      buffers.surfaces.destroy();
      buffers.reflections.destroy();
      this._buffers = undefined;
    }
  }

  private lightBuffer(data: Float32Array<ArrayBuffer>): GpuBuffer {
    if (!this._lights || this._lights.size < data.byteLength) {
      this._lights?.destroy();
      this._lights = this.renderer.backend.buffers.create({
        label: 'reflections lights',
        size: Math.max(data.byteLength, 16 * LightVec4s * 16),
        usage: ['storage', 'copy-dst'],
      });
    }
    this._lights.write(0, data.buffer, data.byteOffset, data.byteLength);
    return this._lights;
  }
}

const vec3 = (value: IVec3) => [value.x, value.y, value.z];
