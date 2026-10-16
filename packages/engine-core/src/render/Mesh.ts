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
  private _destroyed = false;
  private _onDestroy?: Set<(mesh: Mesh) => void>;

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

  // Destroyed meshes cannot be drawn.
  get destroyed(): boolean {
    return this._destroyed;
  }

  /**
   * Calls `listener` when the mesh is destroyed: the renderers that
   * uploaded it free its buffers. Returns the function that unsubscribes.
   */
  onDestroy(listener: (mesh: Mesh) => void): () => void {
    (this._onDestroy ??= new Set()).add(listener);
    return () => this._onDestroy?.delete(listener);
  }

  /**
   * Frees the GPU buffers of the mesh in every renderer that drew it, at
   * once rather than when it is collected. Idempotent.
   */
  destroy(): void {
    if (this._destroyed) {
      return;
    }
    this._destroyed = true;
    const listeners = this._onDestroy;
    this._onDestroy = undefined;
    listeners?.forEach((listener) => listener(this));
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

  /**
   * Replaces the indices, as many as before, in the same format: a model
   * reloaded in place.
   */
  setIndices(data: IndexData): this {
    const description = this._description.indexBuffer;
    if (!description) {
      throw new Error('The mesh has no index buffer');
    }
    const expected =
      description.format === 'uint16' ? Uint16Array : Uint32Array;
    if (!(data instanceof expected) || data.length !== description.count) {
      throw new Error(
        `The indices must be ${description.count} values in a ${expected.name}`
      );
    }
    this._indices = data;
    this._version++;
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
