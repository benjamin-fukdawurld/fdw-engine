import type { CompiledProgram } from '@fdw/engine-shader';
import type { IColor } from '../math';
import type {
  GpuBuffer,
  GpuSampler,
  GpuTexture,
  GpuTextureFormat,
} from '../gpu';
import type { IndexFormat, MeshDescription } from '../mesh';
import type {
  BottomLevelVertices,
  GpuBottomLevel,
  GpuTopLevel,
} from './accelerationStructures';

// Abstract rendering API, modelled on WebGPU: it maps almost directly onto
// Vulkan, Metal and Direct3D 12, and can be emulated on WebGL.

export type CompareFunction =
  | 'never'
  | 'less'
  | 'equal'
  | 'less-equal'
  | 'greater'
  | 'not-equal'
  | 'greater-equal'
  | 'always';

export type PrimitiveTopology =
  | 'triangle-list'
  | 'triangle-strip'
  | 'line-list'
  | 'line-strip'
  | 'point-list';

export interface PrimitiveState {
  readonly topology: PrimitiveTopology;
  readonly cullMode: 'none' | 'front' | 'back';
  readonly frontFace: 'ccw' | 'cw';
}

export interface DepthStencilState {
  readonly format: GpuTextureFormat;
  readonly depthWrite: boolean;
  readonly depthCompare: CompareFunction;
  // Offsets the depth written (shadow maps): a constant, in units of the
  // smallest depth difference, plus a factor of the slope of the triangle.
  readonly depthBias?: number;
  readonly depthBiasSlopeScale?: number;
}

export type BlendFactor =
  | 'zero'
  | 'one'
  | 'src-alpha'
  | 'one-minus-src-alpha'
  | 'dst-alpha'
  | 'one-minus-dst-alpha';

export interface BlendComponent {
  readonly srcFactor: BlendFactor;
  readonly dstFactor: BlendFactor;
  readonly operation: 'add' | 'subtract' | 'reverse-subtract' | 'min' | 'max';
}

export interface BlendState {
  readonly color: BlendComponent;
  readonly alpha: BlendComponent;
}

// Standard alpha blending, for transparent materials.
export const alphaBlending: BlendState = {
  color: {
    srcFactor: 'src-alpha',
    dstFactor: 'one-minus-src-alpha',
    operation: 'add',
  },
  alpha: {
    srcFactor: 'one',
    dstFactor: 'one-minus-src-alpha',
    operation: 'add',
  },
};

export interface ColorTargetState {
  readonly format: GpuTextureFormat;
  readonly blend?: BlendState;
}

export interface RenderPipelineDescriptor {
  readonly label?: string;
  readonly program: CompiledProgram;
  // Vertex buffer layout of the meshes drawn with the pipeline.
  readonly vertex: MeshDescription;
  readonly primitive: PrimitiveState;
  readonly depthStencil?: DepthStencilState;
  readonly targets: readonly ColorTargetState[];
  readonly sampleCount?: number;
}

export interface ComputePipelineDescriptor {
  readonly label?: string;
  // A program with a compute stage.
  readonly program: CompiledProgram;
  /**
   * On the backends with the rayTracingPipeline capability, a program that
   * traces rays runs as the ray generation shader of a ray tracing
   * pipeline: a ray generation per thread of its dispatches (the same
   * results), the hits found by its shaders (the alpha test in an any-hit
   * shader). Elsewhere, or for a program tracing no rays, a compute
   * pipeline. Default false.
   */
  readonly rayTracing?: boolean;
}

// Opaque backend objects.
export interface GpuComputePipeline {
  readonly label?: string;
}

export interface GpuRenderPipeline {
  readonly label?: string;
  // For each vertex buffer slot of the pipeline, the index of the mesh
  // vertex buffer to bind: buffers with no attribute read by the program are
  // left out.
  readonly vertexBuffers: readonly number[];
}

export interface GpuBindGroupLayout {
  // Equal for layouts with the same entries: bind groups created for one can
  // be used with any pipeline that has an equal layout.
  readonly key: string;
}

export interface GpuBindGroup {
  readonly layout: GpuBindGroupLayout;
  // Frees the group once the submitted commands no longer use it, on the
  // backends where it holds native memory (a Vulkan descriptor set). Absent
  // where the garbage collector frees it. Not before the submission of the
  // commands that bind it.
  destroy?(): void;
}

export interface GpuBindGroupEntry {
  readonly binding: number;
  readonly resource:
    | GpuBuffer
    | GpuTexture
    | GpuSampler
    | GpuObjectTable
    | GpuTopLevel;
}

/**
 * The table of the objects drawn (the 'object-table' binding of the
 * programs): a row per object, and the row of each instance drawn. The
 * instance i of a draw reads the row instances[firstInstance + i]. Rows are
 * stable (rewritten when the object changes), the instances follow the
 * order of the draws. Created by RenderBackend.createObjectTable, in the
 * memory the backend chooses (storage buffers, data textures); the bytes
 * of a row follow objectRowLayout.
 */
export interface GpuObjectTable {
  // How many rows and instances it holds.
  readonly rows: number;
  readonly instances: number;
  // Writes rows from `firstRow`: whole rows, rowStride bytes each.
  writeRows(firstRow: number, data: ArrayBufferView<ArrayBuffer>): void;
  // Writes the rows of instances from `firstInstance`.
  writeInstances(firstInstance: number, rows: Uint32Array<ArrayBuffer>): void;
  destroy(): void;
}

export interface ObjectTableDescriptor {
  readonly rows: number;
  readonly instances: number;
  // Bytes per row (objectRowLayout).
  readonly rowStride: number;
  readonly label?: string;
}

// A texture that can be rendered to: a surface image or an offscreen target.
export interface GpuRenderTarget {
  readonly width: number;
  readonly height: number;
  readonly format: GpuTextureFormat;
}

// What a render pass draws into: a render target (a surface image) or a
// texture created with the render-attachment usage.
export type GpuAttachmentTarget = GpuRenderTarget | GpuTexture;

export interface RenderPassColorAttachment {
  readonly target: GpuAttachmentTarget;
  readonly load: 'clear' | 'load';
  readonly clearValue?: IColor;
  // For a multisampled target: the texture its samples are averaged into
  // at the end of the pass.
  readonly resolveTarget?: GpuAttachmentTarget;
}

export interface RenderPassDepthAttachment {
  readonly target: GpuAttachmentTarget;
  readonly load: 'clear' | 'load';
  readonly clearValue?: number;
}

export interface RenderPassDescriptor {
  readonly label?: string;
  readonly colorAttachments: readonly RenderPassColorAttachment[];
  readonly depthAttachment?: RenderPassDepthAttachment;
  // Measures the GPU duration of the pass (see GpuPassTimer).
  readonly timing?: PassTiming;
}

/**
 * Measures the GPU duration of passes: a pass given `{ timer, index }` is
 * measured into slot `index` (below `capacity`). After the passes of a
 * frame, resolve(encoder, frame) records the measures into the command
 * encoder, tagged with a number of the frame; read() then gives, without
 * waiting, the durations of the latest frame whose results arrived (a few
 * frames late), or undefined. Created by RenderBackend.createPassTimer,
 * where the GPU can measure: timestamps in WebGPU (feature
 * `timestamp-query`) and Vulkan, timer queries in WebGL2
 * (`EXT_disjoint_timer_query_webgl2`).
 */
export interface GpuPassTimer {
  readonly capacity: number;
  resolve(encoder: GpuCommandEncoder, frame: number): void;
  // The durations in milliseconds, by slot (NaN for a slot not measured),
  // and the frame they come from.
  read(): PassTimes | undefined;
  destroy(): void;
}

export interface PassTimes {
  readonly frame: number;
  readonly durations: Float64Array;
}

export interface PassTiming {
  readonly timer: GpuPassTimer;
  readonly index: number;
}

export interface GpuRenderPassEncoder {
  setPipeline(pipeline: GpuRenderPipeline): void;
  setBindGroup(index: number, group: GpuBindGroup): void;
  setVertexBuffer(slot: number, buffer: GpuBuffer): void;
  setIndexBuffer(buffer: GpuBuffer, format: IndexFormat): void;
  // `firstInstance`: the first instance, in the instances of the object
  // table (see GpuObjectTable).
  draw(
    vertexCount: number,
    instanceCount?: number,
    firstInstance?: number,
  ): void;
  drawIndexed(
    indexCount: number,
    instanceCount?: number,
    firstInstance?: number,
  ): void;
  // The rectangle drawn into, in pixels from the top left corner of the
  // attachments (the whole attachments by default): a tile of an atlas.
  setViewport(x: number, y: number, width: number, height: number): void;
  end(): void;
}

export interface GpuComputePassEncoder {
  setPipeline(pipeline: GpuComputePipeline): void;
  setBindGroup(index: number, group: GpuBindGroup): void;
  // Runs the compute stage on x × y × z workgroups.
  dispatchWorkgroups(x: number, y?: number, z?: number): void;
  // The number of workgroups is read from a buffer (three u32), written by
  // the GPU. The buffer needs the 'indirect' usage.
  dispatchWorkgroupsIndirect(buffer: GpuBuffer, offset: number): void;
  end(): void;
}

// Opaque recorded commands.
export type GpuCommandBuffer = object;

// How a pass uses a resource, for the synchronization of the explicit APIs
// (Vulkan, Direct3D 12).
export type ResourceUsage =
  | 'color-attachment'
  | 'depth-attachment'
  | 'depth-read'
  | 'sampled'
  | 'storage-read'
  | 'storage-write'
  | 'uniform'
  | 'vertex'
  | 'index'
  | 'indirect'
  | 'copy-src'
  | 'copy-dst';

export interface ResourceTransition {
  readonly resource: GpuAttachmentTarget | GpuBuffer;
  readonly from: ResourceUsage;
  readonly to: ResourceUsage;
}

export interface GpuCommandEncoder {
  beginRenderPass(descriptor: RenderPassDescriptor): GpuRenderPassEncoder;
  copyBufferToBuffer(
    source: GpuBuffer,
    sourceOffset: number,
    destination: GpuBuffer,
    destinationOffset: number,
    size: number,
  ): void;
  // Copies the top left width × height texels of the first level.
  copyTextureToTexture(
    source: GpuAttachmentTarget,
    destination: GpuAttachmentTarget,
    size: { readonly width: number; readonly height: number },
  ): void;
  /**
   * Computes the levels of a texture after the first one, each averaging
   * the previous one, in every layer: after rendering to the first level,
   * or writing it. For textures created with mipLevelCount > 1 (a no-op
   * otherwise), of a format whose levels can be computed
   * (canGenerateMipmaps); 2d, 2d-array and cube textures.
   */
  generateMipmaps(texture: GpuAttachmentTarget): void;
  // Barriers before the next pass, on the backends with explicit
  // synchronization; absent elsewhere.
  transition?(transitions: readonly ResourceTransition[]): void;
  // Throws on backends without compute stages (capability 'compute').
  beginComputePass(label?: string, timing?: PassTiming): GpuComputePassEncoder;
  /**
   * Builds a top level structure from its last update, outside of the
   * passes, before those that trace rays against it (the backend makes
   * the build visible to them). On the backends with the rayQuery
   * capability.
   */
  buildTopLevel?(top: GpuTopLevel): void;
  /**
   * Refits a dynamic bottom level to the positions of its vertices in a
   * buffer of the GPU (written by the passes before: a skinning), outside
   * of the passes, before the builds of the top levels holding it. On the
   * backends with the rayQuery capability.
   */
  refitBottomLevel?(bottom: GpuBottomLevel, vertices: BottomLevelVertices): void;
  finish(): GpuCommandBuffer;
}
