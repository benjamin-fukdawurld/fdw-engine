import type {
  GpuObjectTable,
  ObjectTableDescriptor,
  RenderBackend,
} from '@fdw/engine-backend';
import { ObjectBlockSize } from '../transform/TransformPool';

// A row: the world matrix, then the normal matrix as three columns of
// vec4 (objectRowLayout), as the blocks of a TransformPool.
const RowFloats = ObjectBlockSize / 4;

/**
 * What a row is written from: the object state of the renderer, which also
 * keeps its row.
 */
export interface RowSource {
  // Its row in the table, set by ObjectRows.
  objectRow?: Row;
  // The version of the world matrix: the row is rewritten when it changes.
  current(): number;
  matrix(): ArrayLike<number>;
  // 3 × 3, column-major.
  normalMatrix(): ArrayLike<number>;
  // The block of a TransformPool holding the row as it is.
  pooled?(): { data: Float32Array; byteOffset: number };
}

export interface Row {
  readonly index: number;
  version: number;
}

/**
 * The object table of a renderer: a stable row per object, rewritten when
 * the object changes, and the rows of the instances drawn, appended pass
 * after pass during a frame. The GPU table grows by doubling; the previous
 * one is destroyed at the next frame, once the commands recorded with it are
 * submitted.
 */
export class ObjectRows {
  private _table?: GpuObjectTable;
  private _version = 0;
  private _rows = new Float32Array(RowFloats * 64);
  private _count = 0;
  private readonly _free: number[] = [];
  private readonly _freed = new FinalizationRegistry<number>((index) =>
    this._free.push(index)
  );
  // The rows to write: from the lowest to the highest changed.
  private _dirtyFirst = Infinity;
  private _dirtyEnd = 0;
  private _instances = new Uint32Array(256);
  private _cursor = 0;
  private _executed = false;
  private readonly _retired: GpuObjectTable[] = [];

  constructor(private readonly _backend: RenderBackend) {}

  /** Changes when the GPU table is replaced: its bind groups too. */
  get version(): number {
    return this._version;
  }

  /** The GPU table, created on first use. */
  get table(): GpuObjectTable {
    return this.ensure(1, 1);
  }

  /**
   * A new frame: the instances start over. Called before the passes of a
   * frame are declared; does nothing until a pass of the previous frame ran.
   */
  beginFrame(): void {
    if (!this._executed) {
      return;
    }
    this._executed = false;
    this._cursor = 0;
    for (const table of this._retired) {
      table.destroy();
    }
    this._retired.length = 0;
  }

  /**
   * Records the instances of a pass: the row of each object, written if it
   * changed, then the rows of the instances. Returns the first instance.
   */
  instances<T>(entries: readonly T[], source: (entry: T) => RowSource): number {
    this._executed = true;
    const first = this._cursor;
    const count = entries.length;
    if (first + count > this._instances.length) {
      const grown = new Uint32Array(
        Math.max(this._instances.length * 2, first + count)
      );
      grown.set(this._instances.subarray(0, first));
      this._instances = grown;
    }
    for (let i = 0; i < count; i++) {
      this._instances[first + i] = this.row(source(entries[i]));
    }
    this._cursor += count;
    const table = this.ensure(this._count, this._cursor);
    this.writeDirty(table);
    table.writeInstances(first, this._instances.subarray(first, first + count));
    return first;
  }

  destroy(): void {
    this._table?.destroy();
    this._table = undefined;
    for (const table of this._retired) {
      table.destroy();
    }
    this._retired.length = 0;
  }

  // The row of an object, allocated on first use, updated when its version
  // changed.
  private row(source: RowSource): number {
    let row = source.objectRow;
    if (!row) {
      const index = this._free.pop() ?? this._count++;
      row = { index, version: Number.NaN };
      source.objectRow = row;
      this._freed.register(source, index);
      if (this._count * RowFloats > this._rows.length) {
        const grown = new Float32Array(this._rows.length * 2);
        grown.set(this._rows);
        this._rows = grown;
      }
    }
    const version = source.current();
    if (row.version !== version) {
      this.copy(row.index, source);
      row.version = version;
      this._dirtyFirst = Math.min(this._dirtyFirst, row.index);
      this._dirtyEnd = Math.max(this._dirtyEnd, row.index + 1);
    }
    return row.index;
  }

  private copy(index: number, source: RowSource): void {
    const o = index * RowFloats;
    const pooled = source.pooled?.();
    if (pooled) {
      const from = pooled.byteOffset / 4;
      this._rows.set(pooled.data.subarray(from, from + RowFloats), o);
      return;
    }
    this._rows.set(source.matrix(), o);
    const n = source.normalMatrix();
    for (let column = 0; column < 3; column++) {
      const c = o + 16 + column * 4;
      this._rows[c] = n[column * 3];
      this._rows[c + 1] = n[column * 3 + 1];
      this._rows[c + 2] = n[column * 3 + 2];
      this._rows[c + 3] = 0;
    }
  }

  // The rows changed since the last write, as one range.
  private writeDirty(table: GpuObjectTable): void {
    if (this._dirtyFirst >= this._dirtyEnd) {
      return;
    }
    table.writeRows(
      this._dirtyFirst,
      this._rows.subarray(
        this._dirtyFirst * RowFloats,
        this._dirtyEnd * RowFloats
      )
    );
    this._dirtyFirst = Infinity;
    this._dirtyEnd = 0;
  }

  // A table holding `rows` rows and `instances` instances: the current one,
  // or a larger one with every row written.
  private ensure(rows: number, instances: number): GpuObjectTable {
    const table = this._table;
    if (table && table.rows >= rows && table.instances >= instances) {
      return table;
    }
    const create = this._backend.createObjectTable;
    if (!create) {
      throw new Error('The backend has no object tables');
    }
    const descriptor: ObjectTableDescriptor = {
      rows: Math.max(64, rows * 2, table?.rows ?? 0),
      instances: Math.max(256, instances * 2, table?.instances ?? 0),
      rowStride: ObjectBlockSize,
      label: 'objects',
    };
    const grown = create.call(this._backend, descriptor);
    if (table) {
      // Still used by the commands recorded this frame.
      this._retired.push(table);
    }
    this._table = grown;
    this._version++;
    // Every row, in the new table. The instances of the passes recorded
    // before stay in the previous table, which their bind groups read.
    this._dirtyFirst = 0;
    this._dirtyEnd = Math.max(this._dirtyEnd, this._count);
    return grown;
  }
}
