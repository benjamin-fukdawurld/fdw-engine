import { Signal } from '@preact/signals-core';

export const EngineStateNames = [
  'uninitialized',
  'initializing',
  'ready',
  'paused',
  'destroying',
  'destroyed',
] as const;
export type EngineState = (typeof EngineStateNames)[number];

export interface Engine extends EventTarget {
  state: Signal<EngineState>;
  init(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  destroy(): Promise<void>;
}

export interface Surface {
  width: number;
  height: number;
  init(engine: Engine): Promise<void>;
}

export const MeshAttributeSemanticNames = [
  'position',
  'normal',
  'color',
  'uv',
  'tangent',
  'joints',
  'weights',
] as const;
export type MeshAttributeSemantic =
  | (typeof MeshAttributeSemanticNames)[number]
  | (string & {});

export type VertexFormat = GPUVertexFormat;

export type MeshAttributeDescription = {
  semantic: MeshAttributeSemantic;
  format: VertexFormat;
  offset: number;
};

export type VertexStepMode = GPUVertexStepMode;

export type MeshBufferDescription = {
  stride: number;
  stepMode: VertexStepMode;
  attributes: MeshAttributeDescription[];
};

export type IndexFormat = GPUIndexFormat;

export type MeshDescription = {
  vertexBuffers: MeshBufferDescription[];
  indexBuffer?: {
    format: IndexFormat;
  };
};
