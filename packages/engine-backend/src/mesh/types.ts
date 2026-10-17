import { GpuBuffer } from '../gpu';
import type { PrimitiveTopology } from '../render/types';

export const MeshAttributeSemanticNames = [
  'position',
  'normal',
  'color',
  'uv',
  'tangent',
  'joints',
  'weights',
] as const;
export type MeshAttributeSemanticName =
  (typeof MeshAttributeSemanticNames)[number];
export type MeshAttributeSemantic = MeshAttributeSemanticName | (string & {});

export const VertexAttributeFormats = [
  'float16',
  'float16x2',
  'float16x4',
  'float32',
  'float32x2',
  'float32x3',
  'float32x4',
  'sint16',
  'sint16x2',
  'sint16x4',
  'sint32',
  'sint32x2',
  'sint32x3',
  'sint32x4',
  'sint8',
  'sint8x2',
  'sint8x4',
  'snorm16',
  'snorm16x2',
  'snorm16x4',
  'snorm8',
  'snorm8x2',
  'snorm8x4',
  'uint16',
  'uint16x2',
  'uint16x4',
  'uint32',
  'uint32x2',
  'uint32x3',
  'uint32x4',
  'uint8',
  'uint8x2',
  'uint8x4',
  'unorm16',
  'unorm16x2',
  'unorm16x4',
  'unorm8',
  'unorm8x2',
  'unorm8x4',
] as const;
export type VertexAttributeFormat = (typeof VertexAttributeFormats)[number];

export type IndexFormat = 'uint16' | 'uint32';
export type VertexStepMode = 'instance' | 'vertex';

export type MeshAttributeDescription = {
  semantic: MeshAttributeSemantic;
  format: VertexAttributeFormat;
  offset: number;
};

export type MeshBufferDescription = {
  stride: number;
  stepMode: VertexStepMode;
  attributes: MeshAttributeDescription[];
};

export type MeshIndexDescription = {
  format: IndexFormat;
  count: number;
};

export type MeshDescription = {
  vertexBuffers: MeshBufferDescription[];
  vertexCount: number;
  indexBuffer?: MeshIndexDescription;
  // How the vertices make primitives. Default 'triangle-list'; the lines
  // are for the debug views (no shading, no shadow).
  topology?: PrimitiveTopology;
};

export type Vertex = Partial<Record<MeshAttributeSemantic, ArrayLike<number>>>;

export type MeshInputData = {
  readonly description: MeshDescription;
  readonly vertices: readonly Vertex[];
  readonly indices?: Readonly<ArrayLike<number>>;
};

export type Mesh = {
  readonly description: MeshDescription;
  readonly vertices: readonly GpuBuffer[];
  readonly indices?: GpuBuffer;
};
