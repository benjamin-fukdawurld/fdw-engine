import {
  alphaBlending,
  CameraCache,
  GpuAttachmentTarget,
  GpuBindGroup,
  GpuBindGroupEntry,
  GpuBindGroupLayout,
  GpuBuffer,
  GpuRenderPassEncoder,
  GpuSampler,
  GpuTextureFormat,
  GpuRenderPipeline,
  IColor,
  IVec3,
  meshSemantics,
  PhysicalBindGroup,
  PhysicalProgramLayout,
  PhysicalUniformBlock,
  PrimitiveState,
  RenderBackend,
  RenderPipelineDescriptor,
  Surface,
  TransformCache,
  UniformValue,
} from '@fdw/engine-backend';
import {
  compile,
  GraphBuilder,
  std,
  CompiledProgram,
  MaterialGraphData,
  MaxLights,
  NodeRegistry,
  ToneMapping,
} from '@fdw/engine-shader';
import type { Camera } from '../Camera';
import { Transform } from '../Transform';
import { RenderGraph, TextureHandle } from '../graph/RenderGraph';
import { RenderGraphRunner } from '../graph/RenderGraphRunner';
import { BaseLight, DirectionalLight, PointLight, SpotLight } from '../light';
import { meshBounds, Sphere, transformSphere, unionSpheres } from './bounds';
import { Material, MaterialValue } from './Material';
import { Mesh } from './Mesh';
import { castsShadow, ShadowCameras, ShadowTile } from './shadows';

export interface RenderItem {
  readonly mesh: Mesh;
  readonly material: Material;
  readonly transform: Transform;
  // Drawn into the shadow maps of the lights. Default true; transparent
  // items never cast shadows.
  readonly castShadow?: boolean;
}

export interface RenderOptions {
  readonly items: Iterable<RenderItem>;
  readonly camera: Camera;
  readonly surface: Surface;
  readonly clearColor?: IColor;
  // Seconds, exposed to the materials as the 'time' engine value.
  readonly time?: number;
  // Multiplies the linear colors before the tone mapping. Defaults to 1.
  readonly exposure?: number;
  // Lights of the scene, summed by the lit shading models. Up to MaxLights
  // (16) are used, the others are ignored. Directional and spot lights with
  // castShadow cast shadows.
  readonly lights?: readonly BaseLight[];
}

export interface ScenePassesOptions extends Omit<RenderOptions, 'surface'> {
  // The color target, and its format.
  readonly target: TextureHandle;
  readonly format: GpuTextureFormat;
  // Prefix of the names of the passes and resources: 'scene' by default.
  // Each name has its own frame uniforms: give different names to the
  // views of a graph (several cameras).
  readonly name?: string;
  // Writes the linear colors of the materials, without tone mapping nor
  // encoding: for an HDR target, followed by a tone mapping pass.
  readonly linear?: boolean;
  // Draws the shadows of the lights that cast some. Default true.
  readonly shadows?: boolean;
}

export interface FullscreenPassOptions {
  // A material whose graph ends with output.fullscreen.
  readonly material: Material;
  // Textures of the graph bound to textures of the material, by name.
  readonly inputs?: Readonly<Record<string, TextureHandle>>;
  readonly target: TextureHandle;
  readonly format: GpuTextureFormat;
  readonly load?: 'clear' | 'load';
  readonly clearColor?: IColor;
}

export interface RendererOptions {
  readonly registry?: NodeRegistry;
  // How the linear colors of the materials are written to the surface:
  // tone mapping (multiplied by the exposure of each frame first), and the
  // encoding of the surface. Defaults: no tone mapping, sRGB encoding.
  readonly output?: {
    readonly toneMapping?: ToneMapping;
    readonly encoding?: 'srgb' | 'linear';
  };
  // Create pipelines asynchronously: an item is skipped until its pipeline
  // is ready, instead of blocking the frame while it compiles.
  readonly asyncPipelines?: boolean;
  // Renders the scene in linear colors in an HDR target (rgba16float), then
  // applies the output (tone mapping, encoding) in a full screen pass, where
  // transparent materials blend exactly. Defaults to true when the backend
  // can render to rgba16float; otherwise the output is applied by each
  // material.
  readonly hdr?: boolean;
  // The shadow maps of the lights share a square atlas of this size, in
  // pixels, split in equal tiles. Default 2048.
  readonly shadowAtlasSize?: number;
  // Multisample antialiasing: the scene is drawn with this many samples per
  // pixel (4), then resolved into its target. Default 1 (none).
  readonly samples?: number;
}

type PipelineEntry =
  | { readonly pipeline: GpuRenderPipeline }
  | { readonly pending: Promise<void> };

interface GpuMesh {
  version: number;
  vertexBuffers: GpuBuffer[];
  indexBuffer?: GpuBuffer;
}

interface UniformGroup {
  buffer?: GpuBuffer;
  block?: PhysicalUniformBlock;
  // Bind groups by layout key: programs with equal layouts share them.
  bindGroups: Map<string, GpuBindGroup>;
}

// The frame uniforms of a view (a camera: the scene, a shadow map…), and
// the shadow atlas its programs read.
interface FrameView extends UniformGroup {
  readonly name: string;
  shadowMap?: GpuAttachmentTarget;
}

interface ObjectState extends UniformGroup {
  cache: TransformCache;
  // Version of the world matrix last uploaded.
  version: number;
}

interface MaterialGroupState {
  buffer?: GpuBuffer;
  bindGroup?: GpuBindGroup;
  version: number;
  // Textures and samplers of the bind group, to rebuild it when one changes.
  resources: readonly unknown[];
}

// How a pass draws the items: the program variant and the pipeline state.
interface PassVariant {
  // The color format; the depth format for depth-only passes.
  readonly format: GpuTextureFormat;
  readonly cullMode: PrimitiveState['cullMode'];
  // Linear colors, without the output (HDR target).
  readonly linear: boolean;
  // The lit materials read the shadow atlas.
  readonly shadows: boolean;
  // No color: the shadow maps.
  readonly depthOnly: boolean;
  // Samples per pixel of the attachments.
  readonly samples: number;
}

interface PreparedPipeline {
  // The features the entry was computed with.
  readonly features: object;
  readonly program: CompiledProgram;
  readonly layout: PhysicalProgramLayout;
  readonly pipelineKey: string;
  // A number per pipeline key, to sort the items without comparing strings.
  readonly pipelineId: number;
}

interface PreparedItem {
  readonly item: RenderItem;
  readonly program: CompiledProgram;
  readonly layout: PhysicalProgramLayout;
  readonly pipelineKey: string;
  readonly pipelineId: number;
  readonly object: ObjectState;
  readonly view: FrameView;
}

const normalized = ({ x, y, z }: Readonly<IVec3>): number[] => {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
};

// A cone lighting every direction: the spot factor is always 1.
const noCone = [-1, -2, 0, 0];

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// Directional, point and spot lights: the lights of the shading models.
const isSupported = (light: BaseLight) =>
  light instanceof DirectionalLight ||
  light instanceof PointLight ||
  light instanceof SpotLight;

// The lights of the frame, in the light arrays of the frame uniforms (see
// lightMembers in engine-shader): one vec4 (or mat4) per light and property.
function lightValues(
  lights: readonly BaseLight[],
  shadows: ReadonlyMap<BaseLight, ShadowTile> = new Map()
): Record<string, UniformValue> {
  const arrays: Record<string, number[]> = {
    lightPositions: [],
    lightAmbients: [],
    lightDiffuses: [],
    lightSpeculars: [],
    lightAttenuations: [],
    lightSpotDirections: [],
    lightSpotCones: [],
    lightShadows: [],
    lightShadowRects: [],
    lightShadowMatrices: [],
  };
  const color = (value: Readonly<IVec3>) => [value.x, value.y, value.z, 0];
  let count = 0;
  for (const light of lights) {
    let position: number[];
    let attenuation = [1, 0, 0, 0];
    let spotDirection = [0, 0, 0, 0];
    let cone = noCone;
    if (light instanceof DirectionalLight) {
      // Towards the light: the opposite of the direction it shines in.
      position = [...normalized(light.direction).map((v) => -v), 0];
    } else if (light instanceof PointLight || light instanceof SpotLight) {
      const { x, y, z } = light.position;
      position = [x, y, z, 1];
      attenuation = [
        light.constantAttenuation,
        light.linearAttenuation,
        light.quadraticAttenuation,
        0,
      ];
      if (light instanceof SpotLight) {
        // Cutoffs are half-angles of the cone, in degrees. The inner cosine
        // stays above the outer one: the shader divides by their difference.
        const cosine = (degrees: number) => Math.cos((degrees * Math.PI) / 180);
        const outer = cosine(light.outerCutoff);
        const inner = Math.max(cosine(light.innerCutoff), outer + 1e-4);
        spotDirection = [...normalized(light.direction), 0];
        cone = [inner, outer, 0, 0];
      }
    } else {
      continue;
    }
    const shadow = shadows.get(light);
    arrays['lightPositions'].push(...position);
    arrays['lightAmbients'].push(...color(light.ambient));
    arrays['lightDiffuses'].push(...color(light.diffuse));
    arrays['lightSpeculars'].push(...color(light.specular));
    arrays['lightAttenuations'].push(...attenuation);
    arrays['lightSpotDirections'].push(...spotDirection);
    arrays['lightSpotCones'].push(...cone);
    arrays['lightShadows'].push(...(shadow?.shadow ?? [0, 0, 0, 0]));
    arrays['lightShadowRects'].push(...(shadow?.rect ?? [0, 0, 0, 0]));
    arrays['lightShadowMatrices'].push(...(shadow?.matrix ?? identity));
    count++;
  }
  return { lightCount: count, ...arrays };
}

const frameBlock = (
  layout: PhysicalProgramLayout
): PhysicalUniformBlock | undefined =>
  layout.groups.find((group) => group.slot === 'frame')?.bindings[0]?.block;

// The tone mapping operators of the standard library.
const toneMappingFunctions: Record<string, string> = {
  reinhard: 'color.toneMapReinhard',
  aces: 'color.toneMapAces',
  neutral: 'color.toneMapNeutral',
};

const isHandle = (value: MaterialValue | undefined): boolean =>
  typeof value === 'object' && value !== null && !('length' in value);

// The world bounds of the items with positions.
const sceneBounds = (
  items: readonly RenderItem[],
  objects: (transform: Transform) => ObjectState
): Sphere | undefined =>
  unionSpheres(
    items.flatMap((item) => {
      const local = meshBounds(item.mesh);
      return local
        ? [
            transformSphere(
              local,
              objects(item.transform).cache.worldMatrix.value
            ),
          ]
        : [];
    })
  );

// Draws render items with their materials, on any backend. Programs,
// pipelines, buffers and bind groups are created on first use and cached;
// uniform buffers are only rewritten when their values change.
export class Renderer {
  readonly backend: RenderBackend;
  private readonly _registry?: NodeRegistry;

  private readonly _programs = new WeakMap<
    MaterialGraphData,
    Map<string, CompiledProgram>
  >();
  private readonly _pipelines = new Map<string, PipelineEntry>();
  private readonly _asyncPipelines: boolean;
  private readonly _output: {
    readonly toneMapping: ToneMapping;
    readonly outputEncoding: 'srgb' | 'linear';
  };
  private readonly _meshes = new WeakMap<Mesh, GpuMesh>();
  private readonly _objects = new WeakMap<Transform, ObjectState>();
  private readonly _materials = new WeakMap<
    Material,
    Map<string, MaterialGroupState>
  >();
  private readonly _cameras = new WeakMap<Camera, CameraCache>();
  // Frame uniforms by view name: each scene, shadow map and full screen
  // pass of a graph has its own, all written before the graph runs.
  private readonly _views = new Map<string, FrameView>();
  private readonly _runner: RenderGraphRunner;
  private readonly _hdr: boolean;
  private readonly _shadowAtlasSize: number;
  private readonly _samples: number;
  private readonly _shadowCameras: ShadowCameras;
  private _shadowSampler?: GpuSampler;
  private _toneMapping?: Material;
  // The frame values of the last scene: what the full screen passes read.
  private _frameValues: Record<string, UniformValue> = {
    exposure: 1,
    ...lightValues([]),
  };
  private readonly _fullscreenMesh = new Mesh({
    label: 'fullscreen',
    description: { vertexBuffers: [], vertexCount: 3 },
    vertices: [],
  });
  private readonly _fullscreenTransform = new Transform();
  private readonly _prepared = new WeakMap<
    Material,
    WeakMap<Mesh, Map<string, PreparedPipeline>>
  >();
  private readonly _pipelineIds = new Map<string, number>();
  private readonly _groupLayouts = new WeakMap<
    PhysicalBindGroup,
    GpuBindGroupLayout
  >();

  constructor(backend: RenderBackend, options: RendererOptions = {}) {
    this.backend = backend;
    this._registry = options.registry;
    this._asyncPipelines = options.asyncPipelines ?? false;
    this._runner = new RenderGraphRunner(backend);
    this._hdr =
      options.hdr ??
      backend.capabilities?.renderableFormats?.includes('rgba16float') ??
      false;
    this._output = {
      toneMapping: options.output?.toneMapping ?? 'none',
      outputEncoding: options.output?.encoding ?? 'srgb',
    };
    this._shadowAtlasSize = options.shadowAtlasSize ?? 2048;
    this._samples = options.samples ?? 1;
    this._shadowCameras = new ShadowCameras(backend.cameraMath);
  }

  // Resolves when the pipelines being created asynchronously are ready.
  async whenReady(): Promise<void> {
    await Promise.all(
      [...this._pipelines.values()].map((entry) =>
        'pending' in entry ? entry.pending : undefined
      )
    );
  }

  // Renders a frame to a surface: a render graph with the passes of the
  // scene (see addScenePasses), executed and presented.
  render({ surface, ...options }: RenderOptions): void {
    const graph = new RenderGraph();
    const target = graph.importTexture('surface', surface.getCurrentTarget());
    if (this._hdr) {
      // Linear colors in an HDR target, where transparent materials blend
      // exactly, then tone mapped and encoded by a full screen pass.
      const hdr = graph.createTexture('hdr', { format: 'rgba16float' });
      const scene = this.addScenePasses(graph, {
        ...options,
        target: hdr,
        format: 'rgba16float',
        linear: true,
      });
      this.addFullscreenPass(graph, 'tone mapping', {
        material: this.toneMappingMaterial(),
        inputs: { hdr: scene },
        target,
        format: surface.format,
      });
    } else {
      this.addScenePasses(graph, {
        ...options,
        target,
        format: surface.format,
      });
    }
    this._runner.execute(graph);
    surface.present();
  }

  /**
   * Adds to a render graph the passes drawing the scene into a color target:
   * the shadow maps of the lights that cast shadows (when there are some),
   * the opaque and masked items, with a transient depth buffer, then the
   * transparent ones (only when there are some). With multisampling, they
   * draw into transient multisampled attachments, resolved into the target
   * by the last one. Returns the version of the color target they write.
   */
  addScenePasses(
    graph: RenderGraph,
    {
      items,
      camera,
      target,
      format,
      clearColor,
      time = 0,
      exposure = 1,
      lights = [],
      name = 'scene',
      linear = false,
      shadows = true,
    }: ScenePassesOptions
  ): TextureHandle {
    const list = [...items];
    const used = lights.filter(isSupported).slice(0, MaxLights);
    const casters = shadows ? used.filter(castsShadow) : [];
    const shadowPass =
      casters.length > 0 && this._shadowAtlasSize > 0
        ? this.addShadowPass(graph, `${name} shadows`, list, casters)
        : undefined;

    const view = this.view(name);
    const prepared = list
      .flatMap((item) =>
        this.passes(item).map((cullMode) =>
          this.prepare(
            item,
            {
              format,
              cullMode,
              linear,
              shadows: shadowPass !== undefined,
              depthOnly: false,
              samples: this._samples,
            },
            view
          )
        )
      )
      .filter((entry): entry is PreparedItem => entry !== undefined);
    const cameraCache = this.cameraCache(camera);
    const ordered = this.sort(prepared, cameraCache);
    const position = camera.position;
    this._frameValues = {
      viewProjection: cameraCache.viewProjectionMatrix.value,
      view: cameraCache.viewMatrix.value,
      projection: cameraCache.projectionMatrix.value,
      cameraPosition: [position.x, position.y, position.z],
      time,
      exposure,
      ...lightValues(
        used,
        new Map(shadowPass?.tiles.map((tile) => [tile.light, tile]))
      ),
    };
    if (ordered.length > 0) {
      this.writeView(view, ordered[0].layout, this._frameValues);
    }
    const isTransparent = (entry: PreparedItem) =>
      entry.item.material.renderState.alphaMode === 'blend';
    const opaqueEntries = ordered.filter((entry) => !isTransparent(entry));
    const transparentEntries = ordered.filter(isTransparent);

    // The attachments have the size of the target.
    const size = graph.textureSize(target);
    const multisampled = this._samples > 1;
    const attachment = (suffix: string, attachmentFormat: GpuTextureFormat) =>
      graph.createTexture(`${name} ${suffix}`, {
        format: attachmentFormat,
        ...(size ? { size } : {}),
        ...(multisampled ? { sampleCount: this._samples } : {}),
      });
    const depth = attachment('depth', this.backend.depthFormat);
    const color = multisampled
      ? attachment('multisampled color', format)
      : target;
    const last = transparentEntries.length === 0;
    const opaque = graph.addRasterPass(`${name} opaque`, (pass) => {
      const atlas = shadowPass && pass.read(shadowPass.atlas, 'sampled');
      const written = pass.writeColor(color, {
        load: 'clear',
        clearValue: clearColor,
      });
      return {
        color: written,
        resolved: multisampled && last ? pass.resolveColor(target) : written,
        depth: pass.writeDepth(depth, { load: 'clear', clearValue: 1 }),
        execute: ({ pass: encoder, texture }) => {
          this.bindShadowMap(view, atlas && texture(atlas));
          for (const entry of opaqueEntries) {
            this.draw(encoder, entry);
          }
        },
      };
    });
    if (last) {
      return opaque.resolved;
    }
    // Over the opaque items, tested against their depth without writing it.
    const transparent = graph.addRasterPass(`${name} transparent`, (pass) => {
      pass.readDepth(opaque.depth);
      const atlas = shadowPass && pass.read(shadowPass.atlas, 'sampled');
      const written = pass.writeColor(opaque.color, { load: 'load' });
      return {
        color: multisampled ? pass.resolveColor(target) : written,
        execute: ({ pass: encoder, texture }) => {
          this.bindShadowMap(view, atlas && texture(atlas));
          for (const entry of transparentEntries) {
            this.draw(encoder, entry);
          }
        },
      };
    });
    return transparent.color;
  }

  /**
   * Adds to a render graph a full screen pass (a post-processing effect): a
   * material whose graph ends with output.fullscreen, drawn over the target,
   * with textures of the graph as inputs. Returns the version of the target
   * it writes.
   */
  addFullscreenPass(
    graph: RenderGraph,
    name: string,
    {
      material,
      inputs = {},
      target,
      format,
      load = 'clear',
      clearColor,
    }: FullscreenPassOptions
  ): TextureHandle {
    const view = this.view(name);
    const prepared = this.prepareFullscreen(material, format, view);
    // The frame values of the last scene (exposure…).
    this.writeView(view, prepared.layout, this._frameValues);
    return graph.addRasterPass(name, (pass) => {
      const read = Object.entries(inputs).map(
        ([input, handle]) => [input, pass.read(handle, 'sampled')] as const
      );
      return {
        color: pass.writeColor(target, { load, clearValue: clearColor }),
        execute: ({ pass: encoder, texture }) => {
          for (const [input, handle] of read) {
            const real = texture(handle) as MaterialValue;
            // Pooled textures are stable: the bind group is rebuilt only
            // when the texture changes.
            if (material.getValue(input) !== real) {
              material.setValue(input, real);
            }
          }
          // Skipped while its pipeline is being created.
          if ('pipeline' in (this._pipelines.get(prepared.pipelineKey) ?? {})) {
            this.draw(encoder, prepared);
          }
        },
      };
    }).color;
  }

  destroy(): void {
    for (const view of this._views.values()) {
      view.buffer?.destroy();
    }
    this._views.clear();
    this._shadowSampler?.destroy();
    this._shadowSampler = undefined;
    this._runner.destroy();
    this._pipelines.clear();
  }

  // --- Shadows -------------------------------------------------------------------

  // The pass drawing the shadow maps of the lights into the tiles of an
  // atlas: one depth-only draw of the casters per light, each with the
  // frame uniforms of the light (its view projection).
  private addShadowPass(
    graph: RenderGraph,
    name: string,
    items: readonly RenderItem[],
    lights: readonly (DirectionalLight | SpotLight)[]
  ): { atlas: TextureHandle; tiles: ShadowTile[] } {
    const format = this.backend.depthFormat;
    const bounds = sceneBounds(items, (transform) =>
      this.objectState(transform)
    ) ?? { center: [0, 0, 0], radius: 1 };
    const tiles = this._shadowCameras.tiles(
      lights,
      bounds,
      this._shadowAtlasSize
    );
    const casters = items.filter(
      (item) =>
        item.castShadow !== false &&
        item.material.renderState.alphaMode !== 'blend'
    );
    const draws = tiles.map((tile, index) => {
      const view = this.view(`${name} ${index}`);
      const entries = casters
        .map((item) =>
          this.prepare(
            item,
            {
              format,
              cullMode: item.material.renderState.doubleSided ? 'none' : 'back',
              linear: false,
              shadows: false,
              depthOnly: true,
              samples: 1,
            },
            view
          )
        )
        .filter((entry): entry is PreparedItem => entry !== undefined)
        .sort((a, b) => a.pipelineId - b.pipelineId);
      if (entries.length > 0) {
        this.writeView(view, entries[0].layout, {
          viewProjection: tile.matrix,
        });
      }
      return { tile, entries };
    });

    const atlas = graph.createTexture(`${name} atlas`, {
      format,
      size: { width: this._shadowAtlasSize, height: this._shadowAtlasSize },
    });
    const written = graph.addRasterPass(name, (pass) => ({
      depth: pass.writeDepth(atlas, { load: 'clear', clearValue: 1 }),
      execute: ({ pass: encoder }) => {
        for (const { tile, entries } of draws) {
          const { x, y, width, height } = tile.viewport;
          encoder.setViewport(x, y, width, height);
          for (const entry of entries) {
            this.draw(encoder, entry);
          }
        }
      },
    }));
    return { atlas: written.depth, tiles };
  }

  // The atlas read by the programs of a view, in this frame.
  private bindShadowMap(
    view: FrameView,
    atlas: GpuAttachmentTarget | undefined
  ): void {
    if (atlas && view.shadowMap !== atlas) {
      view.shadowMap = atlas;
      view.bindGroups.clear();
    }
  }

  // Filtered depth comparisons: the visibility is interpolated between
  // texels.
  private shadowSampler(): GpuSampler {
    this._shadowSampler ??= this.backend.textures.createSampler({
      label: 'shadow sampler',
      compare: 'less-equal',
      minFilter: 'linear',
      magFilter: 'linear',
      mipmapFilter: 'nearest',
      wrapModeS: 'clamp-to-edge',
      wrapModeT: 'clamp-to-edge',
    });
    return this._shadowSampler;
  }

  // --- Programs and pipelines --------------------------------------------------

  private program(
    material: Material,
    mesh: Mesh,
    variant?: PassVariant
  ): CompiledProgram {
    const semantics = meshSemantics(mesh.description);
    // The alpha mode selects the variant of the surface: masked materials
    // discard their transparent fragments.
    const features = {
      ...material.features,
      alphaMode: material.renderState.alphaMode,
      ...(variant?.depthOnly
        ? { depthOnly: true }
        : variant?.linear
        ? { toneMapping: 'none', outputEncoding: 'linear' }
        : this._output),
      ...(variant?.shadows ? { shadows: true } : {}),
    };
    const key = `${[...semantics].sort().join(',')}|${JSON.stringify(
      features
    )}`;
    let byAttributes = this._programs.get(material.graph);
    if (!byAttributes) {
      byAttributes = new Map();
      this._programs.set(material.graph, byAttributes);
    }
    let program = byAttributes.get(key);
    if (!program) {
      program = compile(material.graph, {
        vertexAttributes: semantics,
        features,
        ...(this.backend.capabilities
          ? { capabilities: this.backend.capabilities }
          : {}),
        ...(this._registry ? { registry: this._registry } : {}),
      });
      byAttributes.set(key, program);
    }
    return program;
  }

  // A double-sided transparent item is drawn twice: its back faces, then its
  // front faces, so that they blend in the right order (exact for convex
  // shapes). The sort keeps the two passes in this order.
  private passes(item: RenderItem): PrimitiveState['cullMode'][] {
    const { alphaMode, doubleSided } = item.material.renderState;
    if (!doubleSided) {
      return ['back'];
    }
    return alphaMode === 'blend' ? ['front', 'back'] : ['none'];
  }

  // Creates a pipeline on first use, asynchronously if asked. Returns false
  // while it is being created.
  private ensurePipeline(
    key: string,
    descriptor: () => RenderPipelineDescriptor
  ): boolean {
    if (!this._pipelines.has(key)) {
      if (this._asyncPipelines) {
        const pending = this.backend.pipelines
          .createRenderPipelineAsync(descriptor())
          .then((pipeline) => {
            this._pipelines.set(key, { pipeline });
          });
        this._pipelines.set(key, { pending });
      } else {
        this._pipelines.set(key, {
          pipeline: this.backend.pipelines.createRenderPipeline(descriptor()),
        });
      }
    }
    return 'pipeline' in (this._pipelines.get(key) as PipelineEntry);
  }

  // Undefined while the pipeline of the item is being created.
  private prepare(
    item: RenderItem,
    variant: PassVariant,
    view: FrameView
  ): PreparedItem | undefined {
    const { program, layout, pipelineKey, pipelineId } = this.preparedPipeline(
      item,
      variant
    );
    const state = item.material.renderState;
    const ready = this.ensurePipeline(pipelineKey, () => ({
      label: item.material.label ?? program.name,
      program,
      vertex: item.mesh.description,
      primitive: {
        topology: 'triangle-list',
        cullMode: variant.cullMode,
        frontFace: 'ccw',
      },
      depthStencil: variant.depthOnly
        ? {
            format: variant.format,
            depthWrite: true,
            depthCompare: 'less',
            // Against shadow acne on slopes, with the normal offset of the
            // lookups.
            depthBias: 2,
            depthBiasSlopeScale: 2,
          }
        : {
            format: this.backend.depthFormat,
            depthWrite: state.depthTest && state.depthWrite,
            depthCompare: state.depthTest ? 'less' : 'always',
          },
      targets: variant.depthOnly
        ? []
        : [
            {
              format: variant.format,
              ...(state.alphaMode === 'blend' ? { blend: alphaBlending } : {}),
            },
          ],
      ...(variant.samples > 1 ? { sampleCount: variant.samples } : {}),
    }));
    if (!ready) {
      return undefined;
    }
    return {
      item,
      program,
      layout,
      pipelineKey,
      pipelineId,
      object: this.objectState(item.transform),
      view,
    };
  }

  // The program, layout and pipeline key of a material and a mesh in a pass:
  // computed once, then found by identity, as long as the features of the
  // material do not change (its render state never does).
  private preparedPipeline(
    item: RenderItem,
    variant: PassVariant
  ): PreparedPipeline {
    const { material, mesh } = item;
    let byMesh = this._prepared.get(material);
    if (!byMesh) {
      byMesh = new WeakMap();
      this._prepared.set(material, byMesh);
    }
    let byPass = byMesh.get(mesh);
    if (!byPass) {
      byPass = new Map();
      byMesh.set(mesh, byPass);
    }
    const passKey = `${variant.cullMode}|${variant.format}|${variant.linear}|${variant.shadows}|${variant.depthOnly}|${variant.samples}`;
    const cached = byPass.get(passKey);
    if (cached && cached.features === material.features) {
      return cached;
    }

    const program = this.program(material, mesh, variant);
    const vertexKey = JSON.stringify(mesh.description.vertexBuffers);
    const stateKey = JSON.stringify(material.renderState);
    const pipelineKey = `${program.programKey}|${vertexKey}|${stateKey}|${
      variant.cullMode
    }|${variant.format}|${variant.depthOnly ? 'depth-only' : ''}|${
      variant.samples
    }|${this.backend.depthFormat}`;
    let pipelineId = this._pipelineIds.get(pipelineKey);
    if (pipelineId === undefined) {
      pipelineId = this._pipelineIds.size;
      this._pipelineIds.set(pipelineKey, pipelineId);
    }
    const prepared: PreparedPipeline = {
      features: material.features,
      program,
      layout: this.backend.pipelines.resolveLayout(program),
      pipelineKey,
      pipelineId,
    };
    byPass.set(passKey, prepared);
    return prepared;
  }

  // A full screen material: no mesh, no depth, no culling.
  private prepareFullscreen(
    material: Material,
    format: GpuTextureFormat,
    view: FrameView
  ): PreparedItem {
    const mesh = this._fullscreenMesh;
    const program = this.program(material, mesh);
    const pipelineKey = `fullscreen|${program.programKey}|${format}`;
    this.ensurePipeline(pipelineKey, () => ({
      label: material.label ?? program.name,
      program,
      vertex: mesh.description,
      primitive: {
        topology: 'triangle-list',
        cullMode: 'none',
        frontFace: 'ccw',
      },
      targets: [{ format }],
    }));
    return {
      item: { mesh, material, transform: this._fullscreenTransform },
      program,
      layout: this.backend.pipelines.resolveLayout(program),
      pipelineKey,
      pipelineId: -1,
      object: this.objectState(this._fullscreenTransform),
      view,
    };
  }

  // The material of the tone mapping pass of the HDR path: exposure, tone
  // mapping and encoding, as chosen by the output options.
  private toneMappingMaterial(): Material {
    if (!this._toneMapping) {
      const { toneMapping, outputEncoding } = this._output;
      const g = new GraphBuilder('tone mapping');
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
      if (outputEncoding === 'srgb') {
        rgb = g.call('color.linearToSrgb', { color: rgb });
      }
      g.fullscreen({ color: g.call(std.extend, { xyz: rgb, w: 1 }) });
      this._toneMapping = new Material({
        graph: g.build(),
        label: 'tone mapping',
        values: {
          hdrSampler: this.backend.textures.createSampler({
            minFilter: 'nearest',
            magFilter: 'nearest',
            mipmapFilter: 'nearest',
            wrapModeS: 'clamp-to-edge',
            wrapModeT: 'clamp-to-edge',
          }),
        },
      });
    }
    return this._toneMapping;
  }

  // Opaque and masked items first, grouped by pipeline then material to
  // limit state changes; then transparent items, back to front.
  private sort(items: PreparedItem[], camera: CameraCache): PreparedItem[] {
    const opaque = items.filter(
      (entry) => entry.item.material.renderState.alphaMode !== 'blend'
    );
    const transparent = items.filter(
      (entry) => entry.item.material.renderState.alphaMode === 'blend'
    );
    const materialOrder = new Map<Material, number>();
    const materialIndex = (material: Material) => {
      if (!materialOrder.has(material)) {
        materialOrder.set(material, materialOrder.size);
      }
      return materialOrder.get(material) as number;
    };

    opaque.sort(
      (a, b) =>
        a.pipelineId - b.pipelineId ||
        materialIndex(a.item.material) - materialIndex(b.item.material)
    );

    const position = camera.camera.position;
    const distance = (entry: PreparedItem) => {
      const world = entry.object.cache.worldMatrix.value;
      return Math.hypot(
        world[12] - position.x,
        world[13] - position.y,
        world[14] - position.z
      );
    };
    transparent.sort((a, b) => distance(b) - distance(a));

    return [...opaque, ...transparent];
  }

  // --- Uniforms ------------------------------------------------------------------

  private cameraCache(camera: Camera): CameraCache {
    let cache = this._cameras.get(camera);
    if (!cache) {
      cache = new CameraCache(camera, this.backend.cameraMath);
      this._cameras.set(camera, cache);
    }
    return cache;
  }

  private objectState(transform: Transform): ObjectState {
    let state = this._objects.get(transform);
    if (!state) {
      state = {
        cache: new TransformCache({
          transform,
          transformMath: this.backend.transformMath,
        }),
        version: -1,
        bindGroups: new Map(),
      };
      this._objects.set(transform, state);
    }
    return state;
  }

  private view(name: string): FrameView {
    let view = this._views.get(name);
    if (!view) {
      view = { name, bindGroups: new Map() };
      this._views.set(name, view);
    }
    return view;
  }

  private writeBlock(
    block: PhysicalUniformBlock,
    valueOf: (name: string) => UniformValue | undefined
  ): ArrayBuffer {
    const data = new ArrayBuffer(block.size);
    const view = new DataView(data);
    for (const member of block.members) {
      const value = valueOf(member.name);
      if (value === undefined) {
        // Uniforms without value nor default stay at zero.
        continue;
      }
      this.backend.pipelines.layoutStrategy.writeUniform(view, member, value);
    }
    return data;
  }

  // Uploads a uniform block, creating its buffer on first use. Returns true
  // when the buffer was (re)created: the bind groups using it are stale.
  private upload(
    group: { buffer?: GpuBuffer; bindGroups?: Map<string, GpuBindGroup> },
    block: PhysicalUniformBlock,
    data: ArrayBuffer,
    label: string
  ): boolean {
    const created = !group.buffer || group.buffer.size !== block.size;
    if (created) {
      group.buffer?.destroy();
      group.buffer = this.backend.buffers.create({
        label,
        size: block.size,
        usage: ['uniform', 'copy-dst'],
      });
      group.bindGroups?.clear();
    }
    (group.buffer as GpuBuffer).write(0, data);
    return created;
  }

  // Writes the frame uniforms of a view. The views of a graph have their own
  // buffers: they are all written before the graph runs.
  private writeView(
    view: FrameView,
    layout: PhysicalProgramLayout,
    values: Readonly<Record<string, UniformValue>>
  ): void {
    const block = frameBlock(layout);
    if (!block) {
      return;
    }
    view.block = block;
    this.upload(
      view,
      block,
      this.writeBlock(block, (name) => values[name]),
      `${view.name} frame uniforms`
    );
  }

  private updateObject(state: ObjectState, block: PhysicalUniformBlock): void {
    // Reading the version recomputes the matrices if the transform changed.
    const version = state.cache.worldMatrix.version;
    if (state.buffer && state.version === version) {
      return;
    }
    const values: Record<string, UniformValue> = {
      world: state.cache.worldMatrix.value,
      normalMatrix: state.cache.worldNormalMatrix.value,
    };
    this.upload(
      state,
      block,
      this.writeBlock(block, (name) => values[name]),
      'object uniforms'
    );
    state.version = version;
  }

  // --- Bind groups -----------------------------------------------------------------

  // The layout of a group of a program. Physical layouts are cached by
  // program, so their groups are stable objects: a lookup, instead of asking
  // the backend (which builds a key from the bindings) at every draw.
  private bindGroupLayout(group: PhysicalBindGroup): GpuBindGroupLayout {
    let layout = this._groupLayouts.get(group);
    if (!layout) {
      layout = this.backend.pipelines.createBindGroupLayout(group);
      this._groupLayouts.set(group, layout);
    }
    return layout;
  }

  // The frame and object groups: their uniform buffer and, for the frame of
  // the programs reading the shadows, the shadow atlas and its sampler.
  private sharedBindGroup(
    state: UniformGroup & { shadowMap?: GpuAttachmentTarget },
    group: PhysicalBindGroup
  ): GpuBindGroup {
    const layout = this.bindGroupLayout(group);
    let bindGroup = state.bindGroups.get(layout.key);
    if (!bindGroup) {
      bindGroup = this.backend.pipelines.createBindGroup(
        layout,
        group.bindings.map(({ binding, resource }): GpuBindGroupEntry => {
          if (resource.kind === 'uniform-block') {
            return { binding, resource: state.buffer as GpuBuffer };
          }
          if (resource.kind === 'sampler') {
            return { binding, resource: this.shadowSampler() };
          }
          if (!state.shadowMap) {
            throw new Error(
              `"${resource.name}" is read without shadows in the frame`
            );
          }
          return {
            binding,
            resource: state.shadowMap as GpuBindGroupEntry['resource'],
          };
        })
      );
      state.bindGroups.set(layout.key, bindGroup);
    }
    return bindGroup;
  }

  // Material and custom slots: uniforms, textures and samplers come from the
  // material values.
  private materialBindGroup(
    material: Material,
    program: CompiledProgram,
    group: PhysicalBindGroup
  ): GpuBindGroup | undefined {
    if (group.bindings.length === 0) {
      return undefined;
    }
    let groups = this._materials.get(material);
    if (!groups) {
      groups = new Map();
      this._materials.set(material, groups);
    }
    const key = `${program.programKey}:${group.index}`;
    let state = groups.get(key);
    if (!state) {
      state = { version: -1, resources: [] };
      groups.set(key, state);
    }
    if (state.bindGroup && state.version === material.version) {
      return state.bindGroup;
    }

    const name = material.label ?? material.graph.name;
    const resources: unknown[] = [];
    const entries: GpuBindGroupEntry[] = [];
    let bufferCreated = false;
    for (const binding of group.bindings) {
      const { resource } = binding;
      if (resource.kind === 'uniform-block') {
        const block = binding.block as PhysicalUniformBlock;
        const data = this.writeBlock(block, (member) => {
          const value = material.getValue(member);
          if (isHandle(value)) {
            throw new Error(
              `Material "${name}": "${member}" is a uniform, not a texture or sampler`
            );
          }
          return value as UniformValue | undefined;
        });
        bufferCreated =
          this.upload(state, block, data, `${name} uniforms`) || bufferCreated;
        entries.push({
          binding: binding.binding,
          resource: state.buffer as GpuBuffer,
        });
        continue;
      }
      const value = material.getValue(resource.name);
      if (!isHandle(value)) {
        throw new Error(
          `Material "${name}": no ${resource.kind} set for "${resource.name}"`
        );
      }
      resources.push(value);
      entries.push({
        binding: binding.binding,
        resource: value as GpuBindGroupEntry['resource'],
      });
    }

    const resourcesChanged =
      resources.length !== state.resources.length ||
      resources.some((resource, i) => resource !== state?.resources[i]);
    if (!state.bindGroup || resourcesChanged || bufferCreated) {
      state.bindGroup = this.backend.pipelines.createBindGroup(
        this.bindGroupLayout(group),
        entries
      );
      state.resources = resources;
    }
    state.version = material.version;
    return state.bindGroup;
  }

  // --- Drawing -----------------------------------------------------------------------

  private gpuMesh(mesh: Mesh): GpuMesh {
    let gpu = this._meshes.get(mesh);
    if (gpu && gpu.version === mesh.version) {
      return gpu;
    }
    gpu?.vertexBuffers.forEach((buffer) => buffer.destroy());
    gpu?.indexBuffer?.destroy();

    const label = mesh.label ?? 'mesh';
    gpu = {
      version: mesh.version,
      vertexBuffers: mesh.vertices.map((data, i) =>
        this.backend.buffers.create({
          label: `${label} vertices ${i}`,
          size: data.byteLength,
          usage: ['vertex', 'copy-dst'],
          initialData: data,
        })
      ),
      ...(mesh.indices
        ? {
            indexBuffer: this.backend.buffers.create({
              label: `${label} indices`,
              size: mesh.indices.byteLength,
              usage: ['index', 'copy-dst'],
              initialData: mesh.indices,
            }),
          }
        : {}),
    };
    this._meshes.set(mesh, gpu);
    return gpu;
  }

  private draw(
    pass: GpuRenderPassEncoder,
    { item, program, layout, pipelineKey, object, view }: PreparedItem
  ): void {
    const pipeline = (
      this._pipelines.get(pipelineKey) as { pipeline: GpuRenderPipeline }
    ).pipeline;
    pass.setPipeline(pipeline);

    for (const group of layout.groups) {
      let bindGroup: GpuBindGroup | undefined;
      if (group.slot === 'frame') {
        bindGroup = this.sharedBindGroup(view, group);
      } else if (group.slot === 'object') {
        this.updateObject(
          object,
          group.bindings[0].block as PhysicalUniformBlock
        );
        bindGroup = this.sharedBindGroup(object, group);
      } else {
        bindGroup = this.materialBindGroup(item.material, program, group);
      }
      if (bindGroup) {
        pass.setBindGroup(group.index, bindGroup);
      }
    }

    const mesh = this.gpuMesh(item.mesh);
    pipeline.vertexBuffers.forEach((meshBuffer, slot) =>
      pass.setVertexBuffer(slot, mesh.vertexBuffers[meshBuffer])
    );
    if (mesh.indexBuffer && item.mesh.indices) {
      pass.setIndexBuffer(
        mesh.indexBuffer,
        item.mesh.description.indexBuffer?.format ?? 'uint32'
      );
      pass.drawIndexed(item.mesh.indices.length);
    } else {
      pass.draw(item.mesh.description.vertexCount);
    }
  }
}
