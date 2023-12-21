import { vec2, vec3 } from 'gl-matrix';

export type VertexAttributes = 'pos' | 'uv' | 'norm';

export type MeshData = {
  positions: Float32Array;
  uvs: Float32Array;
  normals: Float32Array;

  indices: Uint16Array;
};

export type VertexData = {
  readonly mesh: MeshData;
  readonly index: number;

  position: vec3;
  uv: vec2;
  normal: vec3;
};

export type MeshBuffers = {
  vertices: Float32Array;
  indices?: Uint16Array;

  vertexCount: number;
  attributes: VertexAttributes[];
  interlaced: boolean;
};

export interface IMeshBuilder {
  toBuffers(options: {
    mesh: MeshData;
    attributes: VertexAttributes[];
    interlaced: boolean;
  }): MeshBuffers;
}
