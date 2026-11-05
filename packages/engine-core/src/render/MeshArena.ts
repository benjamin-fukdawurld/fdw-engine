/**
 * Meshes sharing their GPU buffers (design/p24-gpu-driven.md §3.7): the
 * meshes created with the same arena (option `arena` of Mesh) and the same
 * layout (vertex buffers and index format) are placed by the renderer in
 * the same vertex and index buffers, at a base vertex and a first index of
 * their own. Drawn indirectly, the runs of such meshes sharing a material
 * become a single multiple draw (multiDrawIndirect), where the backend has
 * it and the items are culled on the GPU (option gpuCulling).
 *
 * Elsewhere (WebGL2, a backend without multiple indirect draws), the
 * meshes of an arena are uploaded and drawn as the others.
 *
 * @example
 * ```ts
 * const arena = new MeshArena({ label: 'buildings' });
 * const tower = new Mesh({ description, vertices, indices, arena });
 * const house = new Mesh({ description, vertices, indices, arena });
 * renderer.render({ source: city, camera, surface, gpuCulling: true });
 * ```
 */
export class MeshArena {
  readonly label?: string;

  constructor(options: { readonly label?: string } = {}) {
    if (options.label !== undefined) {
      this.label = options.label;
    }
  }
}

/**
 * Ranges of a buffer handed out first fit, and given back: the vertices
 * or the indices of the meshes of an arena, in elements. Grows when a
 * range does not fit (the caller copies the content to a larger buffer).
 */
export class RangeAllocator {
  // The free ranges, sorted by offset, never adjacent.
  private readonly _free: { offset: number; size: number }[];

  constructor(private _capacity: number) {
    this._free = _capacity > 0 ? [{ offset: 0, size: _capacity }] : [];
  }

  /** The elements the buffer holds. */
  get capacity(): number {
    return this._capacity;
  }

  /** The elements not handed out. */
  get available(): number {
    return this._free.reduce((sum, range) => sum + range.size, 0);
  }

  /** The offset of `size` elements, or undefined when they do not fit. */
  allocate(size: number): number | undefined {
    if (size === 0) {
      return 0;
    }
    const index = this._free.findIndex((range) => range.size >= size);
    if (index < 0) {
      return undefined;
    }
    const range = this._free[index];
    const offset = range.offset;
    range.offset += size;
    range.size -= size;
    if (range.size === 0) {
      this._free.splice(index, 1);
    }
    return offset;
  }

  /** Gives a range back, merged with its free neighbors. */
  free(offset: number, size: number): void {
    if (size === 0) {
      return;
    }
    let index = this._free.findIndex((range) => range.offset > offset);
    if (index < 0) {
      index = this._free.length;
    }
    this._free.splice(index, 0, { offset, size });
    const next = this._free[index + 1];
    if (next && offset + size === next.offset) {
      this._free[index].size += next.size;
      this._free.splice(index + 1, 1);
    }
    const previous = this._free[index - 1];
    if (previous && previous.offset + previous.size === offset) {
      previous.size += this._free[index].size;
      this._free.splice(index, 1);
    }
  }

  /** Grows the buffer to `capacity` elements: the new ones are free. */
  grow(capacity: number): void {
    if (capacity <= this._capacity) {
      return;
    }
    this.free(this._capacity, capacity - this._capacity);
    this._capacity = capacity;
  }
}
