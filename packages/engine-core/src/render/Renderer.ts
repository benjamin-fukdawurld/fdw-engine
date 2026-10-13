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
  Mat3,
  Mat4,
  meshSemantics,
  PhysicalBindGroup,
  PhysicalProgramLayout,
  PhysicalUniformBlock,
  PrimitiveState,
  RenderBackend,
  RenderPipelineDescriptor,
  Surface,
  UniformValue,
  IndexFormat,
} from '@fdw/engine-backend';
import { Aabb, Frustum, transformAabb } from '@fdw/engine-geometry';
import {
  compile,
  GraphBuilder,
  std,
  CompiledProgram,
  ConstantValue,
  FunctionDefinition,
  MaterialGraphData,
  MaxLights,
  NodeRegistry,
  SurfaceOutput,
  ToneMapping,
} from '@fdw/engine-shader';
import type { Camera } from '../Camera';
import { Transform } from '../Transform';
import { ObjectBlockSize, TransformLayout } from '../transform/TransformPool';
import { RenderGraph, TextureHandle, TextureSize } from '../graph/RenderGraph';
import { RenderGraphRunner } from '../graph/RenderGraphRunner';
import { BaseLight, DirectionalLight, PointLight, SpotLight } from '../light';
import { meshBox } from './bounds';
import { lightRange } from './lightRange';
import { lightReaches } from './lightVolumes';
import { Material, MaterialValue } from './Material';
import { Mesh } from './Mesh';
import { MaxObjectId, ObjectRows, RowSource } from './ObjectRows';
import {
  AllLayers,
  Renderable,
  RenderSource,
  WorldTransform,
} from './RenderSource';
import { castsShadow, ShadowCameras, ShadowTile } from './shadows';

export interface RenderOptions {
  // What to draw: a source queried for each view (a scene graph), or a list
  // of items, culled one by one.
  readonly source?: RenderSource;
  readonly items?: Iterable<Renderable>;
  // The layers seen by the camera: the items of a source whose layers do
  // not intersect them are not drawn. Default: all.
  readonly layers?: number;
  readonly camera: Camera;
  readonly surface: Surface;
  readonly clearColor?: IColor;
  // Seconds, exposed to the materials as the 'time' engine value.
  readonly time?: number;
  // Multiplies the linear colors before the tone mapping. Defaults to 1.
  readonly exposure?: number;
  // Lights of the scene, summed by the lit shading models; defaults to the
  // lights of the source. Only those that can light what the camera sees
  // are used, up to MaxLights (16), the strongest first. Directional and
  // spot lights with castShadow cast shadows.
  readonly lights?: readonly BaseLight[];
  // When the lights of the view are all bounded (point and spot lights),
  // what none of them reaches is black: it is not drawn. Materials without
  // lighting (unlit) are always drawn; give lit emissive materials an unlit
  // graph, or leave this off. Default false.
  readonly cullUnlit?: boolean;
}

/** What a view of the last frame drew: see Renderer.stats. */
export interface ViewStats {
  // The items the source gave for the camera.
  readonly visible: number;
  // The draws of the scene passes (a double-sided transparent item is
  // drawn twice).
  readonly drawn: number;
  // The draw calls of the scene passes: fewer than `drawn` with an object
  // table, where the items sharing a mesh and a material are instanced.
  readonly drawCalls: number;
  // The lights used: those that can light what the camera sees.
  readonly lights: number;
  readonly shadowMaps: number;
  // The draws into the shadow maps.
  readonly casters: number;
}

/**
 * A target of the scene passes besides the color: what the surfaces write
 * there for each pixel (see addScenePasses).
 */
export interface SceneOutput {
  readonly format: GpuTextureFormat;
  /**
   * What it holds:
   * - a value of the surface or of the engine: 'view-normal',
   *   'world-normal', 'view-depth', 'world-position', 'object-id', 'uv',
   *   or an input of the surface ('base-color', 'alpha', 'roughness'…),
   *   converted to the format;
   * - a function graph of the application, whose inputs are named after
   *   these values (viewNormal, baseColor…), the same for every material;
   * - 'material': what each material writes with g.output(name, value),
   *   `default` for the others.
   * The functions and the materials give the type of the format (vec2f for
   * rg16float, u32 for r32uint).
   */
  readonly value: string | FunctionDefinition;
  readonly default?: ConstantValue;
  // The value of the pixels without object. Default 0 everywhere (0 is
  // also the identifier of no object).
  readonly clearColor?: IColor;
  // The texture written; by default a texture of the graph ('scene normal
  // output' for the output 'normal' of the passes 'scene'), of the size of
  // the color target.
  readonly target?: TextureHandle;
}

/** What the scene passes wrote: the versions to read in later passes. */
export interface ScenePasses<K extends string = string> {
  // The color, resolved: absent without a color target.
  readonly color?: TextureHandle;
  // The depth: multisampled with samples > 1.
  readonly depth: TextureHandle;
  readonly outputs: Readonly<Record<K, TextureHandle>>;
  // The shadow atlas of the lights, when they cast shadows: for the full
  // screen passes that light the scene (deferred rendering).
  readonly shadows?: TextureHandle;
}

export interface ScenePassesOptions<K extends string = string>
  extends Omit<RenderOptions, 'surface'> {
  // The color target, and its format. Without it, the surfaces only write
  // their outputs: their shading models are left out (a G-buffer).
  readonly target?: TextureHandle;
  readonly format?: GpuTextureFormat;
  // Targets written besides the color, by name: see SceneOutput. Only the
  // opaque and masked items write them: transparent ones only blend their
  // color.
  readonly outputs?: Readonly<Record<K, SceneOutput>>;
  // A depth buffer to test against and write (written by earlier passes):
  // loaded, where a new one is cleared.
  readonly depth?: TextureHandle;
  // Whether the color and the outputs start cleared (the default) or with
  // what earlier passes wrote.
  readonly load?: 'clear' | 'load';
  // The items drawn: 'opaque' for the opaque and masked ones (a G-buffer),
  // 'transparent' for the blended ones over the result of earlier passes
  // (with their `depth`). Default 'all'.
  readonly include?: 'all' | 'opaque' | 'transparent';
  // Samples per pixel, the renderer's by default. Outputs of integer
  // formats need 1: their samples cannot be resolved.
  readonly samples?: number;
  // The size of the textures created for the outputs and the depth, when
  // there is no color target nor output target to take it from: the size
  // of the frame by default.
  readonly size?: TextureSize;
  // Prefix of the names of the passes and resources: 'scene' by default.
  // Each name has its own frame uniforms: give different names to the
  // views of a graph (several cameras).
  readonly name?: string;
  // Writes the linear colors of the materials, without tone mapping nor
  // encoding: for an HDR target, followed by a tone mapping pass.
  readonly linear?: boolean;
  // Draws the shadows of the lights that cast some. Default true.
  readonly shadows?: boolean;
  // Textures of the graph bound to the textures of the materials drawn, by
  // name (a mirror rendered by earlier passes): read by the passes, set on
  // every material whose graph has a texture of that name.
  readonly inputs?: Readonly<Record<string, TextureHandle>>;
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
  // Blends the color over the target by its alpha (with load: 'load'): an
  // overlay covering part of the screen, transparent elsewhere.
  readonly blend?: boolean;
  // The extra color targets of the material (its g.target outputs), by
  // name: written in the same pass, at their locations (1, 2…).
  readonly targets?: Readonly<Record<string, FullscreenTarget>>;
  // The shadow atlas of the scene passes (their `shadows`): the shading
  // models called by the material then darken the light by the shadows,
  // as in the scene passes. Without it, the lights cast none.
  readonly shadows?: TextureHandle;
}

// The bytes a pixel of color targets takes, as WebGPU counts them for its
// maxColorAttachmentBytesPerSample limit: each format has a cost and an
// alignment ("render target pixel byte cost" in the specification), the
// targets are added in order.
function colorTargetBytes(formats: readonly GpuTextureFormat[]): number {
  let total = 0;
  for (const format of formats) {
    const [cost, alignment] = /^(rgba8unorm|bgra8unorm|rgb10a2)/.test(format)
      ? [8, format.startsWith('rgb10a2') ? 4 : 1]
      : /^rgba32/.test(format)
      ? [16, 4]
      : /^rg32/.test(format)
      ? [8, 4]
      : /^r32/.test(format)
      ? [4, 4]
      : /^rgba16/.test(format)
      ? [8, 2]
      : /^rg16/.test(format)
      ? [4, 2]
      : /^r16/.test(format)
      ? [2, 2]
      : /^rgba8/.test(format)
      ? [4, 1]
      : /^rg8/.test(format)
      ? [2, 1]
      : [1, 1];
    total = Math.ceil(total / alignment) * alignment + cost;
  }
  return total;
}

// The components of a color format: 1 for r…, 2 for rg…, 4 for the others.
const formatChannels = (format: GpuTextureFormat): 1 | 2 | 4 =>
  /^r\d/.test(format) ? 1 : /^rg\d/.test(format) ? 2 : 4;

/** An extra color target of a full screen pass. */
export interface FullscreenTarget {
  readonly target: TextureHandle;
  readonly format: GpuTextureFormat;
  readonly load?: 'clear' | 'load';
  // For integer formats, the components are integers.
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

// The world matrix of an item, from its Transform or given by its source,
// with what the renderer derives from it.
interface ObjectState extends RowSource {
  matrix(): Mat4;
  normalMatrix(): Mat3;
  // The version of the world matrix.
  current(): number;
  // For the items of a Transform: its block in the pool, whose first bytes
  // are the row of the object table.
  pooled?(): { data: Float32Array; byteOffset: number };
  // The world bounds of the mesh, for the version of the matrix and of the
  // mesh they were computed with.
  readonly bounds: Aabb;
  boundsVersion: number;
  boundsMesh?: Mesh;
  boundsMeshVersion: number;
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
  // Whether the color is written (format), and the other targets.
  readonly color?: boolean;
  readonly outputs?: readonly SurfaceOutput[];
  readonly outputFormats?: readonly GpuTextureFormat[];
  // A key of color and outputs, in the keys of programs and pipelines.
  readonly outputsKey?: string;
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
  readonly item: Renderable;
  readonly program: CompiledProgram;
  readonly layout: PhysicalProgramLayout;
  readonly pipelineKey: string;
  readonly pipelineId: number;
  readonly object: ObjectState;
  readonly view: FrameView;
}

interface BoundState {
  pipeline?: GpuRenderPipeline;
  groups: (GpuBindGroup | undefined)[];
  vertexBuffers: (GpuBuffer | undefined)[];
  indexBuffer?: GpuBuffer;
  indexFormat?: IndexFormat;
}

// Calls `run` for each run of consecutive entries drawn alike (the same
// pipeline, material and mesh, in the same view): one instanced draw.
function forEachRun(
  entries: readonly PreparedItem[],
  run: (start: number, count: number) => void
): void {
  let start = 0;
  while (start < entries.length) {
    const head = entries[start];
    let end = start + 1;
    while (
      end < entries.length &&
      entries[end].pipelineKey === head.pipelineKey &&
      entries[end].item.material === head.item.material &&
      entries[end].item.mesh === head.item.mesh &&
      entries[end].view === head.view
    ) {
      end++;
    }
    run(start, end - start);
    start = end;
  }
}

// The object state of an entry: the source of its row in the object table.
const objectOf = (entry: PreparedItem): ObjectState => entry.object;

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

// A point or spot light with a finite range: what it does not reach is
// black.
const isBounded = (light: BaseLight) =>
  !(light instanceof DirectionalLight) && lightRange(light) !== Infinity;

// Whether a material is lit: its graph ends with a surface whose shading
// model is not unlit. Raw vertex and fragment outputs are not.
const litGraphs = new WeakMap<MaterialGraphData, boolean>();
function isLit(material: Material): boolean {
  let lit = litGraphs.get(material.graph);
  if (lit === undefined) {
    lit = material.graph.nodes.some(
      (node) =>
        node.type === 'output.surface' &&
        (node.params['shadingModel'] ?? 'unlit') !== 'unlit'
    );
    litGraphs.set(material.graph, lit);
  }
  return lit;
}

// Whether the graph of a material reads a texture of that name.
const textureNames = new WeakMap<MaterialGraphData, Set<string>>();
function hasTexture(material: Material, name: string): boolean {
  let names = textureNames.get(material.graph);
  if (!names) {
    names = new Set(
      material.graph.nodes
        .filter((node) => node.type === 'input.texture')
        .map((node) => node.params['name'] as string)
    );
    textureNames.set(material.graph, names);
  }
  return names.has(name);
}

// Clips a box to the bounds of a frustum.
function clipToFrustum(box: Aabb, frustum: Frustum): void {
  if (box.isEmpty()) {
    return;
  }
  const bounds = frustum.bounds(new Aabb());
  for (let axis = 0; axis < 3; axis++) {
    box.min[axis] = Math.max(box.min[axis], bounds.min[axis]);
    box.max[axis] = Math.min(box.max[axis], bounds.max[axis]);
  }
}

// A sphere containing a box.
const sphereOf = (box: Aabb) => ({
  center: box.center() as [number, number, number],
  radius: Math.hypot(...box.halfExtents()),
});

// The squared distance from a point to a box.
function distanceToBox2(
  { x, y, z }: Readonly<IVec3>,
  { min, max }: Aabb
): number {
  const d = (value: number, low: number, high: number) =>
    value < low ? low - value : value > high ? value - high : 0;
  return (
    d(x, min[0], max[0]) ** 2 +
    d(y, min[1], max[1]) ** 2 +
    d(z, min[2], max[2]) ** 2
  );
}

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
  // By Transform, or by the world transform of the items that give one.
  private readonly _objects = new WeakMap<object, ObjectState>();
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
  // The frustum of each view, reused from frame to frame.
  private readonly _frustums = new Map<string, Frustum>();
  private readonly _stats = new Map<string, ViewStats>();
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

  private readonly _bound = new WeakMap<GpuRenderPassEncoder, BoundState>();
  // The object table, on the backends whose programs read it (objectTable
  // capability); its bind groups by layout key, with the version of the
  // table they were made for.
  private readonly _objectRows: ObjectRows;
  private readonly _objectGroups = new Map<
    string,
    { version: number; bindGroup: GpuBindGroup }
  >();

  constructor(backend: RenderBackend, options: RendererOptions = {}) {
    this.backend = backend;
    if (!backend.createObjectTable) {
      throw new Error(
        'The renderer needs a backend with object tables (createObjectTable)'
      );
    }
    this._objectRows = new ObjectRows(backend);
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

  /**
   * What each view of the last frames drew, by name (`scene` for render()):
   * items visible to the camera, draws, lights, shadow maps and their draws.
   */
  get stats(): ReadonlyMap<string, ViewStats> {
    return this._stats;
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
        inputs: { hdr: scene.color },
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
   *
   * Only what the camera can see is drawn: the items the source gives for
   * its frustum, the lights that can light them, and the shadow casters
   * whose shadows can fall on them.
   */
  addScenePasses<K extends string = never>(
    graph: RenderGraph,
    options: ScenePassesOptions<K> & { readonly target: TextureHandle }
  ): ScenePasses<K> & { readonly color: TextureHandle };
  addScenePasses<K extends string = never>(
    graph: RenderGraph,
    options: ScenePassesOptions<K>
  ): ScenePasses<K>;
  addScenePasses(
    graph: RenderGraph,
    {
      source,
      items = [],
      layers = AllLayers,
      camera,
      target,
      format,
      outputs: outputOptions = {},
      depth: givenDepth,
      load = 'clear',
      include = 'all',
      samples = this._samples,
      size: givenSize,
      clearColor,
      time = 0,
      exposure = 1,
      lights,
      name = 'scene',
      linear = false,
      shadows = true,
      cullUnlit = false,
      inputs = {},
    }: ScenePassesOptions
  ): ScenePasses {
    const outputs = this.sceneOutputs(
      name,
      target,
      format,
      outputOptions,
      samples
    );
    if (include === 'transparent' && (!givenDepth || samples > 1)) {
      throw new Error(
        `"${name}": the transparent items are drawn over the depth of earlier passes (give it), with samples: 1`
      );
    }
    this._objectRows.beginFrame();
    const from = source ?? this.listSource(items);
    const cameraCache = this.cameraCache(camera);
    const frustum = this.frustum(name).setFromMatrix(
      cameraCache.viewProjectionMatrix.value
    );
    // What the camera sees, and the bounds of these receivers.
    let list: Renderable[] = [];
    const receivers = Aabb.empty();
    from.query(
      frustum,
      layers,
      (item) => {
        list.push(item);
        const bounds = this.worldBounds(item);
        if (bounds) {
          receivers.union(bounds);
        }
      },
      'camera'
    );
    // What the camera sees of them: a large item (a ground) reaches beyond
    // the frustum, its shadows there are not seen.
    clipToFrustum(receivers, frustum);
    const reaching = this.reachingLights(
      lights ?? [...(from.lights?.() ?? [])],
      frustum
    );
    const used = this.strongestLights(reaching, receivers);
    if (cullUnlit && used.every(isBounded)) {
      // Only what a light reaches, and what needs no light.
      list = list.filter((item) => {
        const bounds = this.worldBounds(item);
        return (
          !bounds ||
          !isLit(item.material) ||
          used.some((light) => lightReaches(light, bounds))
        );
      });
      receivers.makeEmpty();
      for (const item of list) {
        const bounds = this.worldBounds(item);
        if (bounds) {
          receivers.union(bounds);
        }
      }
    }
    const casters =
      shadows && !receivers.isEmpty() ? used.filter(castsShadow) : [];
    const shadowPass =
      casters.length > 0 && this._shadowAtlasSize > 0
        ? this.addShadowPass(
            graph,
            `${name} shadows`,
            from,
            layers,
            casters,
            receivers
          )
        : undefined;

    const view = this.view(name);
    const blended = (item: Renderable) =>
      item.material.renderState.alphaMode === 'blend';
    const prepared = list
      .filter((item) =>
        include === 'all'
          ? // Without color, the transparent items have nothing to write.
            target !== undefined || !blended(item)
          : (include === 'transparent') === blended(item)
      )
      .flatMap((item) =>
        this.passes(item).map((cullMode) =>
          this.prepare(
            item,
            {
              format: format ?? '',
              cullMode,
              linear,
              shadows: shadowPass !== undefined,
              depthOnly: false,
              samples,
              // The transparent items only blend their color.
              ...(blended(item) ? {} : outputs.variant),
            },
            view
          )
        )
      )
      .filter((entry): entry is PreparedItem => entry !== undefined);
    const ordered = this.sort(prepared, cameraCache);
    this._stats.set(name, {
      visible: list.length,
      drawn: ordered.length,
      drawCalls: this.drawCalls(ordered),
      lights: used.length,
      shadowMaps: shadowPass?.tiles.length ?? 0,
      casters: shadowPass?.casters ?? 0,
    });
    const position = camera.position;
    this._frameValues = {
      viewProjection: cameraCache.viewProjectionMatrix.value,
      inverseViewProjection: cameraCache.inverseViewProjectionMatrix.value,
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
    // The textures of the graph read by the materials, and the materials
    // that have them.
    const readInputs = (pass: {
      read(handle: TextureHandle, usage: 'sampled'): TextureHandle;
    }) =>
      Object.entries(inputs).map(([input, handle]) => ({
        input,
        handle: pass.read(handle, 'sampled'),
      }));
    const bindInputs = (
      entries: readonly PreparedItem[],
      read: readonly { input: string; handle: TextureHandle }[],
      texture: (handle: TextureHandle) => unknown
    ) => {
      for (const { input, handle } of read) {
        const real = texture(handle) as MaterialValue;
        for (const material of new Set(
          entries.map((entry) => entry.item.material)
        )) {
          if (
            hasTexture(material, input) &&
            material.getValue(input) !== real
          ) {
            material.setValue(input, real);
          }
        }
      }
    };

    // The attachments have the size of the color target, or of the first
    // output given, or of the frame.
    const sized =
      target ?? outputs.list.find((output) => output.target)?.target;
    const size = (sized && graph.textureSize(sized)) ?? givenSize;
    const multisampled = samples > 1;
    const attachment = (suffix: string, attachmentFormat: GpuTextureFormat) =>
      graph.createTexture(`${name} ${suffix}`, {
        format: attachmentFormat,
        ...(size ? { size } : {}),
        ...(multisampled ? { sampleCount: samples } : {}),
      });
    // What the passes write: the textures resolved into with MSAA.
    const resolved = (output: (typeof outputs.list)[number]) =>
      output.target ??
      graph.createTexture(`${name} ${output.name} output`, {
        format: output.format,
        ...(size ? { size } : {}),
      });
    const depth = givenDepth ?? attachment('depth', this.backend.depthFormat);
    const color =
      target &&
      (multisampled
        ? attachment('multisampled color', format as GpuTextureFormat)
        : target);
    const outputTargets = outputs.list.map((output) => ({
      output,
      resolved:
        multisampled || !output.target ? resolved(output) : output.target,
      written: multisampled
        ? attachment(`multisampled ${output.name} output`, output.format)
        : output.target ?? undefined,
    }));
    const results: Record<string, TextureHandle> = {};
    const transparents = transparentEntries.length > 0 && target !== undefined;
    let colorVersion: TextureHandle | undefined;
    let depthVersion = depth;

    if (include !== 'transparent') {
      const last = !transparents;
      const opaque = graph.addRasterPass(`${name} opaque`, (pass) => {
        const atlas = shadowPass && pass.read(shadowPass.atlas, 'sampled');
        const read = readInputs(pass);
        let written: TextureHandle | undefined;
        let resolvedColor: TextureHandle | undefined;
        if (color && target) {
          written = pass.writeColor(color, { load, clearValue: clearColor });
          resolvedColor =
            multisampled && last ? pass.resolveColor(target) : written;
        }
        // The outputs, in the order of their locations, each resolved
        // right after it is declared.
        for (const {
          output,
          resolved: into,
          written: drawn,
        } of outputTargets) {
          const version = pass.writeColor(drawn ?? into, {
            load,
            clearValue: output.clearColor ?? { r: 0, g: 0, b: 0, a: 0 },
          });
          results[output.name] = multisampled
            ? pass.resolveColor(into)
            : version;
        }
        return {
          color: written,
          resolved: resolvedColor,
          depth: pass.writeDepth(depth, {
            load: givenDepth ? 'load' : 'clear',
            clearValue: 1,
          }),
          execute: ({ pass: encoder, texture }) => {
            this.bindShadowMap(view, atlas && texture(atlas));
            bindInputs(opaqueEntries, read, texture);
            this.drawAll(encoder, opaqueEntries);
          },
        };
      });
      colorVersion = last ? opaque.resolved : opaque.color;
      depthVersion = opaque.depth;
    }
    const atlas = shadowPass ? { shadows: shadowPass.atlas } : {};
    if (!transparents || !target || !color) {
      return {
        ...(colorVersion ? { color: colorVersion } : {}),
        depth: depthVersion,
        outputs: results,
        ...atlas,
      };
    }
    // Over the opaque items, tested against their depth without writing it.
    const over = colorVersion ?? color;
    const transparent = graph.addRasterPass(`${name} transparent`, (pass) => {
      pass.readDepth(depthVersion);
      const atlas = shadowPass && pass.read(shadowPass.atlas, 'sampled');
      const read = readInputs(pass);
      const written = pass.writeColor(over, {
        load: include === 'transparent' ? load : 'load',
        clearValue: clearColor,
      });
      return {
        color: multisampled ? pass.resolveColor(target) : written,
        execute: ({ pass: encoder, texture }) => {
          this.bindShadowMap(view, atlas && texture(atlas));
          bindInputs(transparentEntries, read, texture);
          this.drawAll(encoder, transparentEntries);
        },
      };
    });
    return {
      color: transparent.color,
      depth: depthVersion,
      outputs: results,
      ...atlas,
    };
  }

  // The outputs of scene passes, checked: their locations after the color,
  // their types from their formats, and the variant of the opaque items.
  private sceneOutputs(
    name: string,
    target: TextureHandle | undefined,
    format: GpuTextureFormat | undefined,
    options: Readonly<Record<string, SceneOutput>>,
    samples: number
  ): {
    list: (SceneOutput & { name: string })[];
    variant: Pick<
      PassVariant,
      'color' | 'outputs' | 'outputFormats' | 'outputsKey'
    >;
  } {
    if (target && !format) {
      throw new Error(`"${name}": the color target needs its format`);
    }
    const list = Object.entries(options).map(([output, value]) => ({
      ...value,
      name: output,
    }));
    if (!target && list.length === 0) {
      throw new Error(`"${name}": nothing to write: give a target or outputs`);
    }
    const first = target ? 1 : 0;
    const surfaceOutputs: SurfaceOutput[] = list.map((output, i) => {
      const scalar = /uint$/.test(output.format)
        ? 'u32'
        : /sint$/.test(output.format)
        ? 'i32'
        : 'f32';
      if (scalar !== 'f32' && samples > 1) {
        throw new Error(
          `"${name}": the output "${output.name}" (${output.format}) cannot be multisampled: draw it with samples: 1`
        );
      }
      return {
        name: output.name,
        location: first + i,
        value: output.value,
        channels: formatChannels(output.format),
        scalar,
        ...(output.default !== undefined ? { default: output.default } : {}),
      };
    });
    this.checkColorTargets(name, [
      ...(format && target ? [format] : []),
      ...list.map((output) => output.format),
    ]);
    const outputFormats = list.map((output) => output.format);
    return {
      list,
      variant:
        list.length === 0
          ? {}
          : {
              color: target !== undefined,
              outputs: surfaceOutputs,
              outputFormats,
              outputsKey: JSON.stringify([
                target !== undefined,
                ...surfaceOutputs.map((output) => [
                  output.name,
                  typeof output.value === 'string'
                    ? output.value
                    : output.value.id,
                  output.default ?? null,
                ]),
                outputFormats,
              ]),
            },
    };
  }

  /**
   * Adds to a render graph a full screen pass (a post-processing effect): a
   * material whose graph ends with output.fullscreen, drawn over the target,
   * with textures of the graph as inputs. Returns the version of the target
   * it writes.
   */
  addFullscreenPass<K extends string>(
    graph: RenderGraph,
    name: string,
    options: FullscreenPassOptions & {
      readonly targets: Readonly<Record<K, FullscreenTarget>>;
    }
  ): { color: TextureHandle; targets: Record<K, TextureHandle> };
  addFullscreenPass(
    graph: RenderGraph,
    name: string,
    options: FullscreenPassOptions
  ): TextureHandle;
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
      blend = false,
      targets,
      shadows,
    }: FullscreenPassOptions
  ):
    | TextureHandle
    | { color: TextureHandle; targets: Record<string, TextureHandle> } {
    this._objectRows.beginFrame();
    const view = this.view(name);
    const prepared = this.prepareFullscreen(
      material,
      format,
      view,
      blend,
      targets ?? {},
      shadows !== undefined
    );
    // The frame values of the last scene: its camera, its lights, the
    // exposure…
    this.writeView(view, prepared.layout, this._frameValues);
    const written = graph.addRasterPass(name, (pass) => {
      const read = Object.entries(inputs).map(
        ([input, handle]) => [input, pass.read(handle, 'sampled')] as const
      );
      const atlas = shadows && pass.read(shadows, 'sampled');
      const color = pass.writeColor(target, { load, clearValue: clearColor });
      // The extra targets, in the order of their locations.
      const extra = Object.fromEntries(
        prepared.targets.map((name) => {
          const extra = (targets ?? {})[name];
          return [
            name,
            pass.writeColor(extra.target, {
              load: extra.load ?? 'clear',
              clearValue: extra.clearColor,
            }),
          ];
        })
      );
      return {
        color,
        targets: extra,
        execute: ({ pass: encoder, texture }) => {
          this.bindShadowMap(view, atlas && texture(atlas));
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
            this.drawAll(encoder, [prepared]);
          }
        },
      };
    });
    return targets ? written : written.color;
  }

  destroy(): void {
    for (const view of this._views.values()) {
      view.buffer?.destroy();
    }
    this._views.clear();
    this._shadowSampler?.destroy();
    this._shadowSampler = undefined;
    this._runner.destroy();
    this._objectRows.destroy();
    this._objectGroups.clear();
    this._pipelines.clear();
  }

  // --- Views and culling -----------------------------------------------------------

  // A list of items as a source: each item tested against the frustum with
  // its world bounds. Items without positions are always drawn.
  private listSource(items: Iterable<Renderable>): RenderSource {
    const list = [...items];
    return {
      query: (frustum, _layers, visit) => {
        for (const item of list) {
          const bounds = this.worldBounds(item);
          if (!bounds || frustum.classifyAabb(bounds) !== 'outside') {
            visit(item);
          }
        }
      },
      bounds: (out) => {
        out.makeEmpty();
        for (const item of list) {
          const bounds = this.worldBounds(item);
          if (bounds) {
            out.union(bounds);
          }
        }
        return out;
      },
    };
  }

  private frustum(name: string): Frustum {
    let frustum = this._frustums.get(name);
    if (!frustum) {
      frustum = new Frustum();
      this._frustums.set(name, frustum);
    }
    return frustum;
  }

  // The world bounds of an item: given by its source, or its mesh bounds
  // transformed by its world matrix, recomputed when one of them changes.
  private worldBounds(item: Renderable): Aabb | undefined {
    if (item.bounds) {
      return item.bounds;
    }
    const state = this.objectState(item);
    const version = state.current();
    if (
      state.boundsVersion !== version ||
      state.boundsMesh !== item.mesh ||
      state.boundsMeshVersion !== item.mesh.version
    ) {
      const box = meshBox(item.mesh);
      if (box) {
        transformAabb(box, state.matrix(), state.bounds);
      } else {
        state.bounds.makeEmpty();
      }
      state.boundsVersion = version;
      state.boundsMesh = item.mesh;
      state.boundsMeshVersion = item.mesh.version;
    }
    return state.bounds.isEmpty() ? undefined : state.bounds;
  }

  // The lights that can light something in the frustum: every directional
  // light, and the point and spot lights whose range reaches it.
  private reachingLights(
    lights: readonly BaseLight[],
    frustum: Frustum
  ): BaseLight[] {
    return lights.filter((light) => {
      if (!isSupported(light)) {
        return false;
      }
      if (light instanceof DirectionalLight) {
        return true;
      }
      const range = lightRange(light);
      if (range === Infinity) {
        return true;
      }
      const { x, y, z } = (light as PointLight | SpotLight).position;
      return range > 0 && frustum.intersectsSphere([x, y, z], range);
    });
  }

  // Up to MaxLights lights: the directional ones, then the others by the
  // light they give to the nearest point of the receivers.
  private strongestLights(lights: BaseLight[], receivers: Aabb): BaseLight[] {
    if (lights.length <= MaxLights) {
      return lights;
    }
    const strength = (light: BaseLight) => {
      if (light instanceof DirectionalLight) {
        return Infinity;
      }
      const { constantAttenuation, linearAttenuation, quadraticAttenuation } =
        light as PointLight | SpotLight;
      const d2 = receivers.isEmpty()
        ? 0
        : distanceToBox2((light as PointLight | SpotLight).position, receivers);
      const { x, y, z } = light.diffuse;
      return (
        Math.max(x, y, z) /
        (constantAttenuation +
          linearAttenuation * Math.sqrt(d2) +
          quadraticAttenuation * d2)
      );
    };
    return lights
      .map((light) => ({ light, strength: strength(light) }))
      .sort((a, b) => b.strength - a.strength)
      .slice(0, MaxLights)
      .map(({ light }) => light);
  }

  // --- Shadows -------------------------------------------------------------------

  // The pass drawing the shadow maps of the lights into the tiles of an
  // atlas: one depth-only draw of the casters per light, each with the
  // frame uniforms of the light (its view projection). A shadow map covers
  // the receivers (what the camera sees); its casters are the items of the
  // source in its frustum, which reaches towards the light.
  private addShadowPass(
    graph: RenderGraph,
    name: string,
    source: RenderSource,
    layers: number,
    lights: readonly (DirectionalLight | SpotLight)[],
    receivers: Aabb
  ): { atlas: TextureHandle; tiles: ShadowTile[]; casters: number } {
    const format = this.backend.depthFormat;
    const tiles = this._shadowCameras.tiles(
      lights,
      sphereOf(receivers),
      source.bounds?.(new Aabb()),
      this._shadowAtlasSize
    );
    let casterCount = 0;
    const draws = tiles.map((tile, index) => {
      const view = this.view(`${name} ${index}`);
      const casters: Renderable[] = [];
      source.query(
        this.frustum(`${name} ${index}`).setFromMatrix(tile.matrix),
        layers,
        (item) => {
          if (
            item.castShadow !== false &&
            item.material.renderState.alphaMode !== 'blend'
          ) {
            casters.push(item);
          }
        },
        'shadow'
      );
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
      casterCount += entries.length;
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
          this.drawAll(encoder, entries);
        }
      },
    }));
    return { atlas: written.depth, tiles, casters: casterCount };
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
    variant?: Partial<PassVariant>
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
    )}|${variant?.outputsKey ?? ''}`;
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
        ...(variant?.outputs?.length ? { outputs: variant.outputs } : {}),
        ...(variant?.color === false ? { color: false } : {}),
        // The object data always comes from the table.
        capabilities: { ...this.backend.capabilities, objectTable: true },
        ...(this._registry ? { registry: this._registry } : {}),
      });
      byAttributes.set(key, program);
    }
    return program;
  }

  // A double-sided transparent item is drawn twice: its back faces, then its
  // front faces, so that they blend in the right order (exact for convex
  // shapes). The sort keeps the two passes in this order.
  private passes(item: Renderable): PrimitiveState['cullMode'][] {
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
    item: Renderable,
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
            ...(variant.color === false
              ? []
              : [
                  {
                    format: variant.format,
                    ...(state.alphaMode === 'blend'
                      ? { blend: alphaBlending }
                      : {}),
                  },
                ]),
            // The outputs of the opaque items: never blended.
            ...(variant.outputFormats ?? []).map((format) => ({ format })),
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
      object: this.objectState(item),
      view,
    };
  }

  // The program, layout and pipeline key of a material and a mesh in a pass:
  // computed once, then found by identity, as long as the features of the
  // material do not change (its render state never does).
  private preparedPipeline(
    item: Renderable,
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
    const passKey = `${variant.cullMode}|${variant.format}|${variant.linear}|${
      variant.shadows
    }|${variant.depthOnly}|${variant.samples}|${variant.outputsKey ?? ''}`;
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
    }|${this.backend.depthFormat}|${variant.outputsKey ?? ''}`;
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
    view: FrameView,
    blend: boolean,
    targets: Readonly<Record<string, FullscreenTarget>>,
    shadows: boolean
  ): PreparedItem & { targets: readonly string[] } {
    const mesh = this._fullscreenMesh;
    const program = this.program(material, mesh, { shadows });
    // The extra targets of the program, by location after the color.
    const outputs =
      program.module.entryPoints.find((entry) => entry.stage === 'fragment')
        ?.outputs ?? [];
    const names = outputs
      .filter((output) => output.name !== 'color')
      .map((output, i) => {
        if (output.location !== i + 1) {
          throw new Error(
            `Full screen pass of "${program.name}": the targets take the locations 1, 2… in order ("${output.name}" is at ${output.location})`
          );
        }
        if (!targets[output.name]) {
          throw new Error(
            `Full screen pass of "${program.name}": no texture for its target "${output.name}"`
          );
        }
        return output.name;
      });
    const unknown = Object.keys(targets).filter(
      (name) => !names.includes(name)
    );
    if (unknown.length > 0) {
      throw new Error(
        `Full screen pass of "${
          program.name
        }": the material has no target ${unknown
          .map((name) => `"${name}"`)
          .join(', ')}`
      );
    }
    this.checkColorTargets(program.name, [
      format,
      ...names.map((name) => targets[name].format),
    ]);
    const formats = names.map((name) => targets[name].format);
    const pipelineKey = `fullscreen|${program.programKey}|${[
      format,
      ...formats,
    ].join(',')}|${blend}`;
    this.ensurePipeline(pipelineKey, () => ({
      label: material.label ?? program.name,
      program,
      vertex: mesh.description,
      primitive: {
        topology: 'triangle-list',
        cullMode: 'none',
        frontFace: 'ccw',
      },
      targets: [
        { format, ...(blend ? { blend: alphaBlending } : {}) },
        // The blend is for the color: integer targets cannot blend, and
        // without independentBlend the targets share the same.
        ...formats.map((format) => ({
          format,
          ...(blend && !this.backend.capabilities?.independentBlend
            ? { blend: alphaBlending }
            : {}),
        })),
      ],
    }));
    const item = { mesh, material, transform: this._fullscreenTransform };
    return {
      item,
      program,
      layout: this.backend.pipelines.resolveLayout(program),
      pipelineKey,
      pipelineId: -1,
      object: this.objectState(item),
      view,
      targets: names,
    };
  }

  // Throws when the color targets of a pass exceed what the backend allows.
  private checkColorTargets(
    name: string,
    formats: readonly GpuTextureFormat[]
  ): void {
    const capabilities = this.backend.capabilities;
    const max = capabilities?.maxColorAttachments ?? 4;
    if (formats.length > max) {
      throw new Error(
        `"${name}" writes ${formats.length} color targets, more than the ${max} of the backend (capability maxColorAttachments)`
      );
    }
    const maxBytes = capabilities?.maxColorAttachmentBytesPerSample;
    const bytes = colorTargetBytes(formats);
    if (maxBytes !== undefined && bytes > maxBytes) {
      throw new Error(
        `"${name}" writes ${bytes} bytes per pixel in its color targets, more than the ${maxBytes} of the backend (capability maxColorAttachmentBytesPerSample)`
      );
    }
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

    const meshOrder = new Map<Mesh, number>();
    const meshIndex = (mesh: Mesh) => {
      if (!meshOrder.has(mesh)) {
        meshOrder.set(mesh, meshOrder.size);
      }
      return meshOrder.get(mesh) as number;
    };

    // By pipeline, material, then mesh: the items sharing them follow each
    // other, and become one instanced draw.
    opaque.sort(
      (a, b) =>
        a.pipelineId - b.pipelineId ||
        materialIndex(a.item.material) - materialIndex(b.item.material) ||
        meshIndex(a.item.mesh) - meshIndex(b.item.mesh)
    );

    const position = camera.camera.position;
    const distance = (entry: PreparedItem) => {
      const world = entry.object.matrix();
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

  private objectState(item: Renderable): ObjectState {
    const world = 'world' in item ? item.world : undefined;
    const transform = 'transform' in item ? item.transform : undefined;
    const key = world ?? transform;
    if (!key) {
      throw new Error(
        `Render item of "${
          item.mesh.label ?? 'mesh'
        }" without transform nor world matrix`
      );
    }
    let state = this._objects.get(key);
    if (!state) {
      state = world
        ? this.worldState(world)
        : this.transformState(transform as Transform);
      this._objects.set(key, state);
    }
    const id = item.id ?? 0;
    if (id !== (state.id ?? 0)) {
      if (!Number.isInteger(id) || id < 0 || id > MaxObjectId) {
        throw new Error(
          `The identifier ${id} of "${
            item.mesh.label ?? 'mesh'
          }" is not an integer from 0 to 2^24`
        );
      }
      state.id = id;
    }
    return state;
  }

  // A Transform: its matrices are in its block of the pool, computed when
  // read after a change.
  private transformState(transform: Transform): ObjectState {
    const pool = transform.pool;
    let view: Float32Array | undefined;
    const block = () => {
      const data = pool.data;
      if (!view || view.buffer !== data.buffer) {
        const o = transform.index * TransformLayout.stride;
        view = data.subarray(o, o + ObjectBlockSize / 4);
      }
      return view;
    };
    return {
      matrix: () => {
        pool.update(transform.index);
        return block().subarray(
          TransformLayout.world,
          TransformLayout.world + 16
        );
      },
      normalMatrix: () => {
        pool.updateNormal(transform.index);
        // 3 × 3, without the padding of the columns.
        const n = block();
        const o = TransformLayout.normal;
        return Float32Array.of(
          n[o],
          n[o + 1],
          n[o + 2],
          n[o + 4],
          n[o + 5],
          n[o + 6],
          n[o + 8],
          n[o + 9],
          n[o + 10]
        );
      },
      current: () => pool.worldVersion(transform.index),
      pooled: () => {
        pool.updateNormal(transform.index);
        return {
          data: pool.data,
          byteOffset: transform.index * TransformLayout.stride * 4,
        };
      },
      bounds: new Aabb(),
      boundsVersion: -1,
      boundsMeshVersion: -1,
    };
  }

  // A world matrix given by the source: its normal matrix is derived here,
  // when its version changes.
  private worldState(world: WorldTransform): ObjectState {
    const math = this.backend.transformMath;
    let normal: Mat3 | undefined;
    let normalVersion = -1;
    return {
      matrix: () => world.matrix,
      normalMatrix: () => {
        if (!normal || normalVersion !== world.version) {
          normal = math.getLocalNormalMatrix(world.matrix);
          normalVersion = world.version;
        }
        return normal;
      },
      current: () => world.version,
      bounds: new Aabb(),
      boundsVersion: -1,
      boundsMeshVersion: -1,
    };
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
    label: string,
    dataOffset = 0,
    size?: number
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
    (group.buffer as GpuBuffer).write(0, data, dataOffset, size);
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

  // Draws entries in order: with an object table, their instances first.
  private drawAll(
    pass: GpuRenderPassEncoder,
    entries: readonly PreparedItem[]
  ): void {
    const first = this._objectRows.instances(entries, objectOf);
    forEachRun(entries, (start, count) =>
      this.draw(pass, entries[start], first + start, count)
    );
  }

  // The draw calls of entries: a run of entries sharing a mesh, a material
  // and a pipeline is one, with an object table.
  private drawCalls(entries: readonly PreparedItem[]): number {
    let calls = 0;
    forEachRun(entries, () => calls++);
    return calls;
  }

  private draw(
    pass: GpuRenderPassEncoder,
    { item, program, layout, pipelineKey, view }: PreparedItem,
    instance: number,
    instances: number
  ): void {
    const pipeline = (
      this._pipelines.get(pipelineKey) as { pipeline: GpuRenderPipeline }
    ).pipeline;

    const state = this.boundState(pass);
    if (state.pipeline !== pipeline) {
      pass.setPipeline(pipeline);
      state.pipeline = pipeline;
      state.groups = [];
    }

    for (const group of layout.groups) {
      let bindGroup: GpuBindGroup | undefined;
      if (group.slot === 'frame') {
        bindGroup = this.sharedBindGroup(view, group);
      } else if (group.slot === 'object') {
        bindGroup = this.objectTableBindGroup(group);
      } else {
        bindGroup = this.materialBindGroup(item.material, program, group);
      }
      if (bindGroup && state.groups[group.index] !== bindGroup) {
        pass.setBindGroup(group.index, bindGroup);
        state.groups[group.index] = bindGroup;
      }
    }

    const mesh = this.gpuMesh(item.mesh);
    pipeline.vertexBuffers.forEach((meshBuffer, slot) => {
      const buffer = mesh.vertexBuffers[meshBuffer];
      if (state.vertexBuffers[slot] !== buffer) {
        pass.setVertexBuffer(slot, buffer);
        state.vertexBuffers[slot] = buffer;
      }
    });
    if (mesh.indexBuffer && item.mesh.indices) {
      const format = item.mesh.description.indexBuffer?.format ?? 'uint32';
      if (
        state.indexBuffer !== mesh.indexBuffer ||
        state.indexFormat !== format
      ) {
        pass.setIndexBuffer(mesh.indexBuffer, format);
        state.indexBuffer = mesh.indexBuffer;
        state.indexFormat = format;
      }
      pass.drawIndexed(item.mesh.indices.length, instances, instance);
    } else {
      pass.draw(item.mesh.description.vertexCount, instances, instance);
    }
  }

  // The bind group of the object table, for a layout of the 'object' group:
  // made again when the table grows.
  private objectTableBindGroup(group: PhysicalBindGroup): GpuBindGroup {
    const rows = this._objectRows;
    const layout = this.bindGroupLayout(group);
    const table = rows.table;
    let cached = this._objectGroups.get(layout.key);
    if (!cached || cached.version !== rows.version) {
      cached = {
        version: rows.version,
        bindGroup: this.backend.pipelines.createBindGroup(layout, [
          { binding: group.bindings[0].binding, resource: table },
        ]),
      };
      this._objectGroups.set(layout.key, cached);
    }
    return cached.bindGroup;
  }

  private boundState(pass: GpuRenderPassEncoder): BoundState {
    let state = this._bound.get(pass);
    if (!state) {
      state = { groups: [], vertexBuffers: [] };
      this._bound.set(pass, state);
    }
    return state;
  }
}
