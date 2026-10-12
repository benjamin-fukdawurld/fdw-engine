// Transforms stored in blocks of a single Float32Array: the world matrix and
// the normal matrix (derived), then the local position, rotation and scale.
// The 112 first bytes of a block are the `object` uniform block of the
// programs: the renderer uploads them in one copy. See
// design/scenegraph.md §16.

/** Offsets in a block, in floats. */
export const TransformLayout = {
  // 4 × 4, column-major.
  world: 0,
  // 3 × 3, as 3 columns of 4 floats (the layout of WGSL and std140).
  normal: 16,
  position: 28,
  // A unit quaternion (x, y, z, w).
  rotation: 31,
  scale: 35,
  // Floats per block (160 bytes).
  stride: 40,
} as const;

/** The bytes of the object uniform block: the world and normal matrices. */
export const ObjectBlockSize = 112;

export interface TransformPoolOptions {
  /** The blocks first allocated. Default 64. */
  readonly capacity?: number;
  /** The factor by which a full pool grows. Default 2. */
  readonly growth?: number;
  /**
   * Called when a block changes: a scene keeps its branches and indices up
   * to date with it.
   */
  readonly onTouch?: (index: number) => void;
  /**
   * Computes the matrices of a stale block, then calls markUpdated(): a
   * scene, whose world matrices depend on the parents. By default, the
   * world matrix is the local one.
   */
  readonly compute?: (index: number) => void;
}

const {
  world: W,
  normal: N,
  position: P,
  rotation: R,
  scale: S,
  stride,
} = TransformLayout;

/**
 * A pool of transforms: blocks of a Float32Array, reused when freed, grown
 * by a factor when full. Each block has a local version (incremented at
 * each change) and a world version (incremented when its matrices are
 * recomputed, which happens when they are read after a change).
 */
export class TransformPool {
  private static _default?: TransformPool;

  /** The pool of the transforms created without one. */
  static get default(): TransformPool {
    TransformPool._default ??= new TransformPool();
    return TransformPool._default;
  }

  private _data: Float32Array;
  private _localVersions: Uint32Array;
  private _worldVersions: Uint32Array;
  private _stale: Uint8Array;
  // The normal matrix is computed apart, when read: only the objects drawn
  // need it.
  private _normalStale: Uint8Array;
  private _capacity: number;
  private _next = 0;
  private readonly _free: number[] = [];
  private readonly _growth: number;
  private readonly _onTouch?: (index: number) => void;
  private readonly _compute?: (index: number) => void;

  constructor({
    capacity = 64,
    growth = 2,
    onTouch,
    compute,
  }: TransformPoolOptions = {}) {
    if (growth <= 1) {
      throw new Error('The growth factor of a pool must be above 1');
    }
    this._capacity = Math.max(capacity, 1);
    this._growth = growth;
    this._onTouch = onTouch;
    this._compute = compute;
    this._data = new Float32Array(this._capacity * stride);
    this._localVersions = new Uint32Array(this._capacity);
    this._worldVersions = new Uint32Array(this._capacity);
    this._stale = new Uint8Array(this._capacity);
    this._normalStale = new Uint8Array(this._capacity);
  }

  /**
   * The blocks. Replaced when the pool grows: read it where it is used,
   * rather than keeping it.
   */
  get data(): Float32Array {
    return this._data;
  }

  get capacity(): number {
    return this._capacity;
  }

  /** The number of blocks in use. */
  get size(): number {
    return this._next - this._free.length;
  }

  /** A block: identity transform, its matrices to compute. */
  allocate(): number {
    let index = this._free.pop();
    if (index === undefined) {
      if (this._next === this._capacity) {
        this.grow(this.grownCapacity(this._capacity + 1));
      }
      index = this._next++;
    }
    return this.reset(index);
  }

  /**
   * The block of a given index, reset to the identity: for the owners that
   * index the pool by their own numbers (the entities of a scene). Not to
   * mix with allocate() in the same pool.
   */
  allocateAt(index: number): number {
    if (index >= this._capacity) {
      this.grow(this.grownCapacity(index + 1));
    }
    this._next = Math.max(this._next, index + 1);
    return this.reset(index);
  }

  /** Makes room for `count` blocks: one growth instead of many. */
  reserve(count: number): void {
    if (count > this._capacity) {
      this.grow(count);
    }
  }

  // The capacity after the growths needed to hold `needed` blocks.
  private grownCapacity(needed: number): number {
    let capacity = this._capacity;
    while (capacity < needed) {
      capacity = Math.max(capacity + 1, Math.ceil(capacity * this._growth));
    }
    return capacity;
  }

  private reset(index: number): number {
    const data = this._data;
    const o = index * stride;
    data.fill(0, o, o + stride);
    data[o + R + 3] = 1;
    data[o + S] = 1;
    data[o + S + 1] = 1;
    data[o + S + 2] = 1;
    this._stale[index] = 1;
    // A new transform starts at version 0.
    this._localVersions[index] = 0;
    return index;
  }

  free(index: number): void {
    this._free.push(index);
  }

  /** Signals a change of the local values of a block. */
  touch(index: number): void {
    this._localVersions[index]++;
    this._stale[index] = 1;
    this._onTouch?.(index);
  }

  /**
   * Marks the matrices of a block as stale, its local values unchanged: a
   * parent moved.
   */
  invalidate(index: number): void {
    this._stale[index] = 1;
  }

  localVersion(index: number): number {
    return this._localVersions[index];
  }

  /** The version of the matrices, recomputed first if the block changed. */
  worldVersion(index: number): number {
    if (this._stale[index]) {
      this.update(index);
    }
    return this._worldVersions[index];
  }

  isStale(index: number): boolean {
    return this._stale[index] === 1;
  }

  /**
   * Computes the world matrix of a block if it changed: from its local
   * values (a transform without parent), or by the `compute` of its owner.
   */
  update(index: number): void {
    if (!this._stale[index]) {
      return;
    }
    if (this._compute) {
      this._compute(index);
      return;
    }
    composeBlock(this._data, index * stride);
    this.markUpdated(index);
  }

  /**
   * Computes the normal matrix of a block if needed (and its world matrix
   * first): the 112 first bytes of the block are then the object uniforms.
   */
  updateNormal(index: number): void {
    if (this._stale[index]) {
      this.update(index);
    }
    if (this._normalStale[index]) {
      normalBlock(this._data, index * stride);
      this._normalStale[index] = 0;
    }
  }

  /**
   * For the owners that compute the world matrix themselves (a scene, from
   * the parents): the world matrix of the block is up to date; its normal
   * matrix will be computed from it when read (updateNormal()).
   */
  markUpdated(index: number): void {
    this._stale[index] = 0;
    this._normalStale[index] = 1;
    this._worldVersions[index]++;
  }

  private grow(capacity: number): void {
    const grow = <A extends Float32Array | Uint32Array | Uint8Array>(
      array: A,
      length: number
    ): A => {
      const grown = new (array.constructor as new (n: number) => A)(length);
      grown.set(array);
      return grown;
    };
    this._data = grow(this._data, capacity * stride);
    this._localVersions = grow(this._localVersions, capacity);
    this._worldVersions = grow(this._worldVersions, capacity);
    this._stale = grow(this._stale, capacity);
    this._normalStale = grow(this._normalStale, capacity);
    this._capacity = capacity;
  }
}

/**
 * Writes the world matrix of a block (at offset `o` of `data`) from its
 * local position, rotation and scale.
 */
export function composeBlock(data: Float32Array, o: number): void {
  const x = data[o + R];
  const y = data[o + R + 1];
  const z = data[o + R + 2];
  const w = data[o + R + 3];
  const sx = data[o + S];
  const sy = data[o + S + 1];
  const sz = data[o + S + 2];
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  data[o + W] = (1 - 2 * (yy + zz)) * sx;
  data[o + W + 1] = 2 * (xy + wz) * sx;
  data[o + W + 2] = 2 * (xz - wy) * sx;
  data[o + W + 3] = 0;
  data[o + W + 4] = 2 * (xy - wz) * sy;
  data[o + W + 5] = (1 - 2 * (xx + zz)) * sy;
  data[o + W + 6] = 2 * (yz + wx) * sy;
  data[o + W + 7] = 0;
  data[o + W + 8] = 2 * (xz + wy) * sz;
  data[o + W + 9] = 2 * (yz - wx) * sz;
  data[o + W + 10] = (1 - 2 * (xx + yy)) * sz;
  data[o + W + 11] = 0;
  data[o + W + 12] = data[o + P];
  data[o + W + 13] = data[o + P + 1];
  data[o + W + 14] = data[o + P + 2];
  data[o + W + 15] = 1;
}

/**
 * Writes the normal matrix of a block from its world matrix: the inverse
 * transpose of its 3 × 3 part, as 3 columns of 4 floats.
 */
export function normalBlock(data: Float32Array, o: number): void {
  const a00 = data[o + W];
  const a01 = data[o + W + 1];
  const a02 = data[o + W + 2];
  const a10 = data[o + W + 4];
  const a11 = data[o + W + 5];
  const a12 = data[o + W + 6];
  const a20 = data[o + W + 8];
  const a21 = data[o + W + 9];
  const a22 = data[o + W + 10];
  // The names are column then row: a01 is column 0, row 1. With B the
  // matrix whose (i, j) is aij, the 3 × 3 part is Bᵀ, and its inverse
  // transpose is cofactors(B)ᵀ / determinant: column c holds the cofactors
  // of row c of B.
  const c00 = a11 * a22 - a12 * a21;
  const c01 = a12 * a20 - a10 * a22;
  const c02 = a10 * a21 - a11 * a20;
  const c10 = a02 * a21 - a01 * a22;
  const c11 = a00 * a22 - a02 * a20;
  const c12 = a01 * a20 - a00 * a21;
  const c20 = a01 * a12 - a02 * a11;
  const c21 = a02 * a10 - a00 * a12;
  const c22 = a00 * a11 - a01 * a10;
  const determinant = a00 * c00 + a01 * c01 + a02 * c02;
  const inverse = determinant !== 0 ? 1 / determinant : 0;
  data[o + N] = c00 * inverse;
  data[o + N + 1] = c01 * inverse;
  data[o + N + 2] = c02 * inverse;
  data[o + N + 3] = 0;
  data[o + N + 4] = c10 * inverse;
  data[o + N + 5] = c11 * inverse;
  data[o + N + 6] = c12 * inverse;
  data[o + N + 7] = 0;
  data[o + N + 8] = c20 * inverse;
  data[o + N + 9] = c21 * inverse;
  data[o + N + 10] = c22 * inverse;
  data[o + N + 11] = 0;
}
