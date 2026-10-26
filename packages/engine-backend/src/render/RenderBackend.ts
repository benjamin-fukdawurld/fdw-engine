import type {
  GpuBufferFactory,
  GpuSamplerFactory,
  GpuTextureFactory,
} from '../gpu';
import type { CameraMath, TransformMath } from '../math';
import type {
  PhysicalBindGroup,
  PhysicalLayoutStrategy,
  PhysicalProgramLayout,
  ShaderCodegen,
} from '../shader';
import type { CompiledProgram, CompilerCapabilities } from '@fdw/engine-shader';
import type { GpuTextureFormat } from '../gpu';
import type {
  BottomLevelDescriptor,
  GpuBottomLevel,
  GpuTopLevel,
  TopLevelDescriptor,
} from './accelerationStructures';
import type {
  ComputePipelineDescriptor,
  GpuComputePipeline,
  GpuBindGroup,
  GpuBindGroupEntry,
  GpuBindGroupLayout,
  GpuCommandBuffer,
  GpuCommandEncoder,
  GpuObjectTable,
  GpuPassTimer,
  GpuRenderPipeline,
  GpuRenderTarget,
  ObjectTableDescriptor,
  RenderPipelineDescriptor,
} from './types';

export interface GpuPipelineFactory {
  readonly codegen: ShaderCodegen;
  readonly layoutStrategy: PhysicalLayoutStrategy;
  // Physical layout of a program, cached by program key.
  resolveLayout(program: CompiledProgram): PhysicalProgramLayout;
  createRenderPipeline(descriptor: RenderPipelineDescriptor): GpuRenderPipeline;
  createRenderPipelineAsync(
    descriptor: RenderPipelineDescriptor,
  ): Promise<GpuRenderPipeline>;
  // Throws on backends without compute stages (capability 'compute').
  createComputePipeline(
    descriptor: ComputePipelineDescriptor,
  ): GpuComputePipeline;
  createComputePipelineAsync(
    descriptor: ComputePipelineDescriptor,
  ): Promise<GpuComputePipeline>;
  // Cached: equal groups give the same layout object.
  createBindGroupLayout(group: PhysicalBindGroup): GpuBindGroupLayout;
  createBindGroup(
    layout: GpuBindGroupLayout,
    entries: readonly GpuBindGroupEntry[],
  ): GpuBindGroup;
}

export interface RenderTargetDescriptor {
  readonly width: number;
  readonly height: number;
  readonly format: GpuTextureFormat;
  readonly label?: string;
}

/**
 * What a backend supports: the limits of the compiled programs, and the
 * formats it can render to beyond the 8 bits ones.
 */
export interface BackendCapabilities extends Partial<CompilerCapabilities> {
  // Color formats usable as render pass attachments, besides rgba8unorm and
  // the formats of the surfaces (e.g. rgba16float for HDR rendering).
  readonly renderableFormats?: readonly GpuTextureFormat[];
  // The compressed formats the device can sample (bc7-rgba-unorm…, see
  // compressedBlock): the loaders pick among them. None when absent.
  readonly compressedFormats?: readonly GpuTextureFormat[];
  // The highest anisotropy of the samplers (1: no anisotropic filtering).
  // Higher values are clamped to it.
  readonly maxAnisotropy?: number;
  // Color attachments of a render pass (4 when absent, the minimum of
  // WebGL2).
  readonly maxColorAttachments?: number;
  // The bytes of all the color attachments of a pass for one sample, where
  // the backend limits them (WebGPU: 32).
  readonly maxColorAttachmentBytesPerSample?: number;
  // Whether the color targets of a pipeline can have different blend
  // states. Without it (WebGL2), the float targets share the same.
  readonly independentBlend?: boolean;
  // Compute stages emulated by draws into textures (WebGL2), not compute
  // shaders: no indirect dispatch, and slower. The features with another
  // path there prefer it (the skinning in the vertex stage).
  readonly emulatedCompute?: boolean;
  // Ray tracing pipelines (Vulkan, with rayQuery): the compute programs
  // tracing rays can run as their ray generation shaders, the hardware
  // scheduling their hits (ComputePipelineDescriptor.rayTracing).
  readonly rayTracingPipeline?: boolean;
}

// Everything a renderer needs from a backend, once its device is ready.
export interface RenderBackend {
  readonly buffers: GpuBufferFactory;
  readonly textures: GpuTextureFactory<unknown> & GpuSamplerFactory;
  readonly pipelines: GpuPipelineFactory;
  // Math implementations matching the conventions of the backend (clip
  // space, matrix layout).
  readonly cameraMath: CameraMath;
  readonly transformMath: TransformMath;
  // Preferred depth format for depth attachments.
  readonly depthFormat: GpuTextureFormat;
  // Limits of the backend that the compiled programs must respect; the
  // guaranteed limits of WebGPU when absent.
  readonly capabilities?: BackendCapabilities;
  createRenderTarget(
    descriptor: RenderTargetDescriptor,
  ): GpuRenderTarget & { destroy(): void };
  createCommandEncoder(): GpuCommandEncoder;
  // An object table, on the backends whose programs read the object data
  // from it (the objectTable capability).
  createObjectTable?(descriptor: ObjectTableDescriptor): GpuObjectTable;
  // A timer of `capacity` passes; absent, or undefined, where the GPU cannot
  // measure (see GpuPassTimer).
  createPassTimer?(capacity: number): GpuPassTimer | undefined;
  // The acceleration structures of the rays, on the backends with the
  // rayQuery capability (see GpuTopLevel).
  createBottomLevel?(descriptor: BottomLevelDescriptor): GpuBottomLevel;
  createTopLevel?(descriptor?: TopLevelDescriptor): GpuTopLevel;
  submit(commands: readonly GpuCommandBuffer[]): void;
}
