import type { CompiledProgram } from '@fdw/engine-shader';
import type { IColor } from '../math';
import type {
  GpuBuffer,
  GpuSampler,
  GpuTexture,
  GpuTextureFormat,
} from '../gpu';
import type { IndexFormat, MeshDescription } from '../mesh';

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

// Opaque backend objects.
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
}

export interface GpuBindGroupEntry {
  readonly binding: number;
  readonly resource: GpuBuffer | GpuTexture | GpuSampler;
}

// A texture that can be rendered to: a surface image or an offscreen target.
export interface GpuRenderTarget {
  readonly width: number;
  readonly height: number;
  readonly format: GpuTextureFormat;
}

export interface RenderPassColorAttachment {
  readonly target: GpuRenderTarget;
  readonly load: 'clear' | 'load';
  readonly clearValue?: IColor;
}

export interface RenderPassDepthAttachment {
  readonly target: GpuRenderTarget;
  readonly load: 'clear' | 'load';
  readonly clearValue?: number;
}

export interface RenderPassDescriptor {
  readonly label?: string;
  readonly colorAttachments: readonly RenderPassColorAttachment[];
  readonly depthAttachment?: RenderPassDepthAttachment;
}

export interface GpuRenderPassEncoder {
  setPipeline(pipeline: GpuRenderPipeline): void;
  setBindGroup(index: number, group: GpuBindGroup): void;
  setVertexBuffer(slot: number, buffer: GpuBuffer): void;
  setIndexBuffer(buffer: GpuBuffer, format: IndexFormat): void;
  draw(vertexCount: number, instanceCount?: number): void;
  drawIndexed(indexCount: number, instanceCount?: number): void;
  end(): void;
}

// Opaque recorded commands.
export type GpuCommandBuffer = object;

export interface GpuCommandEncoder {
  beginRenderPass(descriptor: RenderPassDescriptor): GpuRenderPassEncoder;
  finish(): GpuCommandBuffer;
}
