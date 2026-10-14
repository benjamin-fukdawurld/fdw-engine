import type { MeshDescription } from '@fdw/engine-backend';

export type IndexData = Uint16Array<ArrayBuffer> | Uint32Array<ArrayBuffer>;

// Geometry on the CPU side: vertex buffers laid out as described, and
// optional indices. The renderer uploads it when it is first drawn, and again
// after each change.
export class Mesh {
  readonly label?: string;

  private _description: MeshDescription;
  private _vertices: ArrayBufferView<ArrayBuffer>[];
  private _indices?: IndexData;
  private _version = 0;

  constructor({
    description,
    vertices,
    indices,
    label,
  }: {
    description: MeshDescription;
    // One per vertex buffer of the description.
    vertices: readonly ArrayBufferView<ArrayBuffer>[];
    indices?: IndexData;
    label?: string;
  }) {
    if (vertices.length !== description.vertexBuffers.length) {
      throw new Error(
        `The mesh describes ${description.vertexBuffers.length} vertex buffers but ${vertices.length} were given`
      );
    }
    if (!!indices !== !!description.indexBuffer) {
      throw new Error(
        description.indexBuffer
          ? 'The mesh describes an index buffer but no indices were given'
          : 'Indices were given but the mesh describes no index buffer'
      );
    }
    if (indices && description.indexBuffer) {
      const expected =
        description.indexBuffer.format === 'uint16' ? Uint16Array : Uint32Array;
      if (!(indices instanceof expected)) {
        throw new Error(
          `The indices must be a ${expected.name}, as described by the mesh`
        );
      }
    }

    this._description = description;
    this.label = label;
    this._vertices = [...vertices];
    this._indices = indices;
  }

  get description(): MeshDescription {
    return this._description;
  }

  get version(): number {
    return this._version;
  }

  get vertices(): readonly ArrayBufferView<ArrayBuffer>[] {
    return this._vertices;
  }

  get indices(): IndexData | undefined {
    return this._indices;
  }

  /**
   * Changes the number of vertices drawn, without uploading anything: for
   * the meshes without indices whose vertices are generated in the vertex
   * shader from their index (the patches of a tessellated surface). Within
   * the vertex buffers, if it has some.
   */
  setVertexCount(count: number): this {
    if (this._description.indexBuffer) {
      throw new Error('The vertex count of an indexed mesh cannot change');
    }
    this._description = { ...this._description, vertexCount: count };
    return this;
  }

  setVertices(buffer: number, data: ArrayBufferView<ArrayBuffer>): this {
    if (buffer < 0 || buffer >= this._vertices.length) {
      throw new Error(`The mesh has no vertex buffer ${buffer}`);
    }
    this._vertices[buffer] = data;
    this._version++;
    return this;
  }
}
