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
  GpuBindGroup,
  GpuBindGroupEntry,
  GpuBindGroupLayout,
  GpuCommandBuffer,
  GpuCommandEncoder,
  GpuRenderPipeline,
  GpuRenderTarget,
  RenderPipelineDescriptor,
} from './types';

export interface GpuPipelineFactory {
  readonly codegen: ShaderCodegen;
  readonly layoutStrategy: PhysicalLayoutStrategy;
  // Physical layout of a program, cached by program key.
  resolveLayout(program: CompiledProgram): PhysicalProgramLayout;
  createRenderPipeline(descriptor: RenderPipelineDescriptor): GpuRenderPipeline;
  createRenderPipelineAsync(
    descriptor: RenderPipelineDescriptor
  ): Promise<GpuRenderPipeline>;
  // Cached: equal groups give the same layout object.
  createBindGroupLayout(group: PhysicalBindGroup): GpuBindGroupLayout;
  createBindGroup(
    layout: GpuBindGroupLayout,
    entries: readonly GpuBindGroupEntry[]
  ): GpuBindGroup;
}

export interface RenderTargetDescriptor {
  readonly width: number;
  readonly height: number;
  readonly format: GpuTextureFormat;
  readonly label?: string;
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
  readonly capabilities?: Partial<CompilerCapabilities>;
  createRenderTarget(
    descriptor: RenderTargetDescriptor
  ): GpuRenderTarget & { destroy(): void };
  createCommandEncoder(): GpuCommandEncoder;
  submit(commands: readonly GpuCommandBuffer[]): void;
}
