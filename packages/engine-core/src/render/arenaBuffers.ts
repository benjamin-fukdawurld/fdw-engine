import type { GpuBuffer, RenderBackend } from '@fdw/engine-backend';
import type { Mesh } from './Mesh';
import { MeshArena, RangeAllocator } from './MeshArena';

/**
 * Where a mesh of an arena is on the GPU: the buffers it shares with the
 * other meshes of its arena and layout, its first vertex and first index
 * there. The buffers change when they grow: read them at each draw.
 */
export interface ArenaPlacement {
  readonly vertexBuffers: readonly GpuBuffer[];
  readonly indexBuffer?: GpuBuffer;
  readonly baseVertex: number;
  readonly firstIndex: number;
  // The buffers shared, the same object for every mesh in them: the draws
  // of meshes with the same `shared` can be one multiple draw.
  readonly shared: object;
}

// The buffers of the meshes of an arena with one layout.
interface SharedBuffers {
  readonly label: string;
  readonly strides: readonly number[];
  readonly indexSize: number;
  vertexBuffers: GpuBuffer[];
  indexBuffer?: GpuBuffer;
  readonly vertices: RangeAllocator;
  readonly indices: RangeAllocator;
}

interface Placed {
  readonly shared: SharedBuffers;
  readonly vertexCount: number;
  readonly indexCount: number;
  baseVertex: number;
  firstIndex: number;
}

// The first capacity of the buffers of an arena, in vertices and indices.
const FirstCapacity = 4096;

/**
 * The GPU buffers of the meshes of arenas, for a renderer: see MeshArena.
 * The ranges of the meshes are handed out first fit; a buffer too small
 * grows (doubles), its content copied by the GPU.
 */
export class ArenaBuffers {
  private readonly _shared = new Map<MeshArena, Map<string, SharedBuffers>>();
  private readonly _placed = new Map<Mesh, Placed>();

  constructor(
    private readonly _backend: RenderBackend,
    // Destroys a buffer once the commands recorded with it are submitted.
    private readonly _retire: (buffer: GpuBuffer) => void,
  ) {}

  /**
   * Places a mesh of an arena (again, when its data changed: `full`),
   * uploads its data, and returns where it is.
   */
  place(mesh: Mesh, full = true): ArenaPlacement {
    const arena = mesh.arena as MeshArena;
    let placed = this._placed.get(mesh);
    if (placed && full) {
      this.release(mesh);
      placed = undefined;
    }
    if (!placed) {
      const shared = this.shared(arena, mesh);
      const vertexCount = mesh.description.vertexCount;
      // 16-bit indices by pairs: the writes go by 4 bytes.
      const count = mesh.description.indexBuffer?.count ?? 0;
      const indexCount =
        shared.indexSize === 2 ? Math.ceil(count / 2) * 2 : count;
      const baseVertex = this.allocate(shared, 'vertices', vertexCount);
      const firstIndex = this.allocate(shared, 'indices', indexCount);
      placed = { shared, vertexCount, indexCount, baseVertex, firstIndex };
      this._placed.set(mesh, placed);
      mesh.vertices.forEach((data, i) =>
        shared.vertexBuffers[i].write(
          baseVertex * shared.strides[i],
          data.buffer,
          data.byteOffset,
          data.byteLength,
        ),
      );
      const indices = mesh.indices;
      if (indices && shared.indexBuffer) {
        let bytes = new Uint8Array(
          indices.buffer as ArrayBuffer,
          indices.byteOffset,
          indices.byteLength,
        );
        if (bytes.byteLength % 4 !== 0) {
          const padded = new Uint8Array(indexCount * shared.indexSize);
          padded.set(bytes);
          bytes = padded;
        }
        shared.indexBuffer.write(
          firstIndex * shared.indexSize,
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength,
        );
      }
    }
    return this.placement(placed);
  }

  /** Writes parts of the vertices of a placed mesh (Mesh.updateVertices). */
  update(
    mesh: Mesh,
    updates: readonly {
      readonly buffer: number;
      readonly byteOffset: number;
      readonly data: Uint8Array<ArrayBuffer>;
    }[],
  ): void {
    const placed = this._placed.get(mesh);
    if (!placed) {
      return;
    }
    for (const { buffer, byteOffset, data } of updates) {
      placed.shared.vertexBuffers[buffer].write(
        placed.baseVertex * placed.shared.strides[buffer] + byteOffset,
        data.buffer,
        data.byteOffset,
        data.byteLength,
      );
    }
  }

  /** Where a placed mesh is, or undefined. */
  placementOf(mesh: Mesh): ArenaPlacement | undefined {
    const placed = this._placed.get(mesh);
    return placed && this.placement(placed);
  }

  /** Gives the ranges of a mesh back. */
  release(mesh: Mesh): void {
    const placed = this._placed.get(mesh);
    if (!placed) {
      return;
    }
    this._placed.delete(mesh);
    placed.shared.vertices.free(placed.baseVertex, placed.vertexCount);
    placed.shared.indices.free(placed.firstIndex, placed.indexCount);
  }

  destroy(): void {
    for (const layouts of this._shared.values()) {
      for (const shared of layouts.values()) {
        shared.vertexBuffers.forEach((buffer) => buffer.destroy());
        shared.indexBuffer?.destroy();
      }
    }
    this._shared.clear();
    this._placed.clear();
  }

  private placement(placed: Placed): ArenaPlacement {
    const { shared } = placed;
    return {
      get vertexBuffers() {
        return shared.vertexBuffers;
      },
      get indexBuffer() {
        return shared.indexBuffer;
      },
      baseVertex: placed.baseVertex,
      firstIndex: placed.firstIndex,
      shared,
    };
  }

  // The buffers of the arena for the layout of a mesh.
  private shared(arena: MeshArena, mesh: Mesh): SharedBuffers {
    const { vertexBuffers, indexBuffer } = mesh.description;
    const key = JSON.stringify([
      vertexBuffers.map(({ stride, stepMode, attributes }) => [
        stride,
        stepMode,
        attributes,
      ]),
      indexBuffer?.format ?? null,
    ]);
    let layouts = this._shared.get(arena);
    if (!layouts) {
      layouts = new Map();
      this._shared.set(arena, layouts);
    }
    let shared = layouts.get(key);
    if (!shared) {
      const label = `${arena.label ?? 'arena'} ${layouts.size}`;
      const strides = vertexBuffers.map((buffer) => buffer.stride);
      if (strides.some((stride) => stride % 4 !== 0)) {
        throw new Error(
          `The meshes of an arena have vertices of whole u32 (strides ${strides.join(', ')})`,
        );
      }
      const indexSize = indexBuffer?.format === 'uint16' ? 2 : 4;
      shared = {
        label,
        strides,
        indexSize,
        vertexBuffers: strides.map((stride, i) =>
          this.createBuffer(
            `${label} vertices ${i}`,
            stride * FirstCapacity,
            'vertex',
          ),
        ),
        ...(indexBuffer
          ? {
              indexBuffer: this.createBuffer(
                `${label} indices`,
                indexSize * FirstCapacity,
                'index',
              ),
            }
          : {}),
        vertices: new RangeAllocator(FirstCapacity),
        indices: new RangeAllocator(indexBuffer ? FirstCapacity : 0),
      };
      layouts.set(key, shared);
    }
    return shared;
  }

  // A range of `count` vertices or indices, the buffers grown if needed.
  private allocate(
    shared: SharedBuffers,
    which: 'vertices' | 'indices',
    count: number,
  ): number {
    const ranges = shared[which];
    let offset = ranges.allocate(count);
    if (offset === undefined) {
      const capacity = Math.max(
        ranges.capacity * 2,
        ranges.capacity + count,
        FirstCapacity,
      );
      this.grow(shared, which, ranges.capacity, capacity);
      ranges.grow(capacity);
      offset = ranges.allocate(count) as number;
    }
    return offset;
  }

  // Replaces the vertex or index buffers by larger ones, their content
  // copied: the meshes keep their places.
  private grow(
    shared: SharedBuffers,
    which: 'vertices' | 'indices',
    from: number,
    to: number,
  ): void {
    const encoder = this._backend.createCommandEncoder();
    const copy = (
      old: GpuBuffer,
      size: number,
      label: string,
      usage: 'vertex' | 'index',
    ) => {
      const grown = this.createBuffer(label, size * to, usage);
      if (from > 0) {
        encoder.copyBufferToBuffer(old, 0, grown, 0, size * from);
      }
      this._retire(old);
      return grown;
    };
    if (which === 'vertices') {
      shared.vertexBuffers = shared.vertexBuffers.map((buffer, i) =>
        copy(
          buffer,
          shared.strides[i],
          `${shared.label} vertices ${i}`,
          'vertex',
        ),
      );
    } else if (shared.indexBuffer) {
      shared.indexBuffer = copy(
        shared.indexBuffer,
        shared.indexSize,
        `${shared.label} indices`,
        'index',
      );
    }
    this._backend.submit([encoder.finish()]);
  }

  private createBuffer(
    label: string,
    size: number,
    usage: 'vertex' | 'index',
  ): GpuBuffer {
    // Whole u32: the copies and the writes go by 4 bytes.
    return this._backend.buffers.create({
      label,
      size: Math.max(Math.ceil(size / 4) * 4, 256),
      usage: [usage, 'copy-dst', 'copy-src'],
    });
  }
}
