import type { MeshDescription } from '@fdw/engine-backend';

export type IndexData = Uint16Array<ArrayBuffer> | Uint32Array<ArrayBuffer>;

/** The data of a mesh: its vertex buffers, and its indices if it has some. */
export interface MeshData {
  readonly vertices: readonly ArrayBufferView<ArrayBuffer>[];
  readonly indices?: IndexData;
}

/** @internal A part of a vertex buffer rewritten (Mesh.updateVertices). */
export interface MeshUpdate {
  // The version of the mesh after it.
  readonly version: number;
  readonly buffer: number;
  readonly byteOffset: number;
  readonly data: Uint8Array<ArrayBuffer>;
}

// The partial updates a mesh remembers for the renderers that are behind;
// a renderer further behind uploads the whole mesh again.
const MaxUpdates = 64;

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
  private readonly _regenerate?: () => MeshData;
  private _released = false;
  private _updates: MeshUpdate[] = [];
  // The oldest version the updates bring up to date.
  private _updatesFrom = 0;

  constructor({
    description,
    vertices,
    indices,
    label,
    regenerate,
  }: {
    description: MeshDescription;
    // One per vertex buffer of the description.
    vertices: readonly ArrayBufferView<ArrayBuffer>[];
    indices?: IndexData;
    label?: string;
    // Makes the data again, as it is now. With it, the mesh gives its CPU
    // copy back once a renderer uploaded it (releaseData), and makes it
    // again when it is read: for the meshes derived from others (a static
    // batch), whose copy would only take memory.
    regenerate?: () => MeshData;
  }) {
    if (vertices.length !== description.vertexBuffers.length) {
      throw new Error(
        `The mesh describes ${description.vertexBuffers.length} vertex buffers but ${vertices.length} were given`,
      );
    }
    if (!!indices !== !!description.indexBuffer) {
      throw new Error(
        description.indexBuffer
          ? 'The mesh describes an index buffer but no indices were given'
          : 'Indices were given but the mesh describes no index buffer',
      );
    }
    if (indices && description.indexBuffer) {
      const expected =
        description.indexBuffer.format === 'uint16' ? Uint16Array : Uint32Array;
      if (!(indices instanceof expected)) {
        throw new Error(
          `The indices must be a ${expected.name}, as described by the mesh`,
        );
      }
      if (indices.length !== description.indexBuffer.count) {
        throw new Error(
          `The mesh describes ${description.indexBuffer.count} indices but ${indices.length} were given`,
        );
      }
    }

    this._description = description;
    this.label = label;
    this._vertices = [...vertices];
    this._indices = indices;
    this._regenerate = regenerate;
  }

  /** Whether the CPU copy can be given back: the mesh can regenerate it. */
  get releasable(): boolean {
    return this._regenerate !== undefined;
  }

  /** Whether the CPU copy was given back, to be made again when read. */
  get released(): boolean {
    return this._released;
  }

  /**
   * Gives the CPU copy of the data back, for a mesh that can regenerate it
   * (`regenerate`): the renderers call it once they uploaded the mesh.
   * Reading `vertices` or `indices` makes it again.
   */
  releaseData(): void {
    if (!this._regenerate) {
      throw new Error(
        `The mesh "${this.label ?? 'mesh'}" cannot regenerate its data`,
      );
    }
    this._vertices = [];
    this._indices = undefined;
    this._released = true;
  }

  // The data, made again if it was released.
  private data(): void {
    if (!this._released || !this._regenerate) {
      return;
    }
    const { vertices, indices } = this._regenerate();
    if (vertices.length !== this._description.vertexBuffers.length) {
      throw new Error(
        `The mesh "${this.label ?? 'mesh'}" regenerated ${vertices.length} vertex buffers instead of ${this._description.vertexBuffers.length}`,
      );
    }
    this._vertices = [...vertices];
    this._indices = indices;
    this._released = false;
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
    this.data();
    return this._vertices;
  }

  get indices(): IndexData | undefined {
    this.data();
    return this._indices;
  }

  /**
   * Rewrites a part of a vertex buffer, from `byteOffset`, without the rest:
   * the renderers write only these bytes to the GPU (offset and size in
   * multiples of 4, as WebGPU writes buffers). The CPU copy, if kept, is
   * updated too.
   */
  updateVertices(
    buffer: number,
    byteOffset: number,
    data: ArrayBufferView<ArrayBuffer>,
  ): this {
    const layout = this._description.vertexBuffers[buffer];
    if (!layout) {
      throw new Error(`The mesh has no vertex buffer ${buffer}`);
    }
    const size = layout.stride * this._description.vertexCount;
    if (
      byteOffset % 4 !== 0 ||
      data.byteLength % 4 !== 0 ||
      byteOffset < 0 ||
      byteOffset + data.byteLength > size
    ) {
      throw new Error(
        `The update of ${data.byteLength} bytes at ${byteOffset} is not aligned on 4 bytes or out of the ${size} bytes of vertex buffer ${buffer}`,
      );
    }
    const bytes = new Uint8Array(
      data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    );
    if (!this._released) {
      const target = this._vertices[buffer];
      new Uint8Array(target.buffer, target.byteOffset, target.byteLength).set(
        bytes,
        byteOffset,
      );
    }
    this._version++;
    this._updates.push({
      version: this._version,
      buffer,
      byteOffset,
      data: bytes,
    });
    if (this._updates.length > MaxUpdates) {
      this._updatesFrom = (this._updates.shift() as MeshUpdate).version;
    }
    return this;
  }

  /**
   * @internal The partial updates that bring the data of `version` up to
   * date, in order; undefined when they do not reach back to it (a whole
   * change since, or too many updates): the mesh is uploaded again.
   */
  updatesSince(version: number): readonly MeshUpdate[] | undefined {
    if (version < this._updatesFrom || version > this._version) {
      return undefined;
    }
    return this._updates.filter((update) => update.version > version);
  }

  // A whole change: the partial updates no longer bring older data to it.
  private changedWhole(): void {
    this._version++;
    this._updates = [];
    this._updatesFrom = this._version;
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
        `The indices must be ${description.count} values in a ${expected.name}`,
      );
    }
    this.data();
    this._indices = data;
    this.changedWhole();
    return this;
  }

  setVertices(buffer: number, data: ArrayBufferView<ArrayBuffer>): this {
    if (buffer < 0 || buffer >= this._vertices.length) {
      throw new Error(`The mesh has no vertex buffer ${buffer}`);
    }
    this.data();
    this._vertices[buffer] = data;
    this.changedWhole();
    return this;
  }
}
