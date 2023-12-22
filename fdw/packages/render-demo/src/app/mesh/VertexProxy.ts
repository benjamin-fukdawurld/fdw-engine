import { vec2, vec3 } from 'gl-matrix';
import { MeshData } from './types';

export class VertexProxy {
  public readonly mesh: MeshData;
  public index: number;

  constructor(options: { mesh: MeshData; index?: number }) {
    this.mesh = options.mesh;
    this.index = options.index ?? 0;
  }

  get positionIndex(): number {
    return this.mesh.indices[this.index * 3]; //[0];
  }

  get positionOffset(): number {
    return this.positionIndex * 3;
  }

  get uvIndex(): number {
    return this.mesh.indices[this.index * 3]; //[1];
  }

  get uvOffset(): number {
    return this.uvIndex * 2;
  }

  get normalIndex(): number {
    return this.mesh.indices[this.index * 3]; //[2];
  }

  get normalOffset(): number {
    return this.normalIndex * 3;
  }

  get position(): vec3 {
    const offset = this.positionOffset;
    return this.mesh.positions.subarray(offset, offset + 3);
  }

  set position(value: vec3) {
    const offset = this.positionOffset;
    vec3.copy(this.mesh.positions.subarray(offset, offset + 3), value);
  }

  get uv(): vec2 {
    const offset = this.uvOffset;
    return this.mesh.uvs.subarray(offset, offset + 2);
  }

  set uv(value: vec2) {
    const offset = this.uvOffset;
    vec2.copy(this.mesh.uvs.subarray(offset, offset + 2), value);
  }

  get normal(): vec3 {
    const offset = this.normalOffset;
    return this.mesh.normals.subarray(offset, offset + 3);
  }

  set normal(value: vec3) {
    const offset = this.normalOffset;
    vec3.copy(this.mesh.normals.subarray(offset, offset + 3), value);
  }
}

export default VertexProxy;
