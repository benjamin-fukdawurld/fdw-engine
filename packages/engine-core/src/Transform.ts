import type {
  ArrayQuat,
  ArrayVec3,
  IQuat,
  IVec3,
  TransformSnapshot,
} from '@fdw/engine-backend';
import { TransformLayout, TransformPool } from './TransformPool';

const { stride } = TransformLayout;

// The blocks of the transforms collected without dispose(): given back to
// their pool by the garbage collector. The held value must not reference
// the transform, or it would never be collected.
const registry = new FinalizationRegistry<{
  readonly pool: TransformPool;
  readonly index: number;
}>(({ pool, index }) => pool.free(index));

// A component of a transform, read and written in its block of the pool:
// its writes invalidate the transform like the others.
class PooledVector {
  /** @internal */
  constructor(
    protected readonly _transform: Transform,
    private readonly _offset: number,
  ) {}

  protected read(i: number): number {
    const { pool, index } = this._transform;
    return pool.data[index * stride + this._offset + i];
  }

  protected write(i: number, value: number): void {
    const { pool, index } = this._transform;
    pool.data[index * stride + this._offset + i] = value;
    pool.touch(index);
  }

  // Writes several components, then signals one change.
  protected writeAll(values: ArrayLike<number>, length: number): void {
    const { pool, index } = this._transform;
    pool.data.set(
      Array.prototype.slice.call(values, 0, length),
      index * stride + this._offset,
    );
    pool.touch(index);
  }

  protected copy(length: number): Float32Array {
    const { pool, index } = this._transform;
    const o = index * stride + this._offset;
    return pool.data.slice(o, o + length);
  }
}

/** A vector of a Transform, read and written in its pool. */
export class PooledVec3 extends PooledVector implements ArrayVec3 {
  get x(): number {
    return this.read(0);
  }
  set x(value: number) {
    this.write(0, value);
  }
  get y(): number {
    return this.read(1);
  }
  set y(value: number) {
    this.write(1, value);
  }
  get z(): number {
    return this.read(2);
  }
  set z(value: number) {
    this.write(2, value);
  }
  /** A copy of the values. */
  asArray(): Float32Array {
    return this.copy(3);
  }
  set(values: ArrayLike<number>): void {
    this.writeAll(values, 3);
  }
}

/** The rotation of a Transform, read and written in its pool. */
export class PooledQuat extends PooledVector implements ArrayQuat {
  get x(): number {
    return this.read(0);
  }
  set x(value: number) {
    this.write(0, value);
  }
  get y(): number {
    return this.read(1);
  }
  set y(value: number) {
    this.write(1, value);
  }
  get z(): number {
    return this.read(2);
  }
  set z(value: number) {
    this.write(2, value);
  }
  get w(): number {
    return this.read(3);
  }
  set w(value: number) {
    this.write(3, value);
  }
  /** A copy of the values. */
  asArray(): Float32Array {
    return this.copy(4);
  }
  set(values: ArrayLike<number>): void {
    this.writeAll(values, 4);
  }
}

/**
 * Position, rotation (a unit quaternion) and scale of an object: a block of
 * a TransformPool, which also holds its world and normal matrices,
 * recomputed after each change when read. Setters take partial values
 * (`transform.position = { y: 2 }` keeps x and z), and every change, even
 * of a single component (`transform.position.y = 2`), increments its
 * version.
 *
 * `dispose()` gives its block back to the pool at once; otherwise the
 * garbage collector does, after the transform is collected.
 */
export class Transform implements TransformSnapshot {
  readonly pool: TransformPool;
  private _index: number;
  // The block is owned by another (a scene), which frees it and detaches
  // the transform.
  private readonly _owned: boolean = false;
  private readonly _position = new PooledVec3(this, TransformLayout.position);
  private readonly _rotation = new PooledQuat(this, TransformLayout.rotation);
  private readonly _scale = new PooledVec3(this, TransformLayout.scale);

  constructor(
    data?: {
      readonly position?: Partial<IVec3>;
      readonly rotation?: Partial<IQuat>;
      readonly scale?: Partial<IVec3>;
    },
    pool: TransformPool = TransformPool.default,
    /** @internal The index of a block owned by another: see Transform.of(). */
    owned?: number,
  ) {
    this.pool = pool;
    if (owned !== undefined) {
      this._index = owned;
      this._owned = true;
      return;
    }
    this._index = pool.allocate();
    registry.register(this, { pool, index: this._index }, this);
    const values = pool.data;
    const o = this._index * stride;
    const { position, rotation, scale } = data ?? {};
    if (position) {
      values[o + TransformLayout.position] = position.x ?? 0;
      values[o + TransformLayout.position + 1] = position.y ?? 0;
      values[o + TransformLayout.position + 2] = position.z ?? 0;
    }
    if (rotation) {
      values[o + TransformLayout.rotation] = rotation.x ?? 0;
      values[o + TransformLayout.rotation + 1] = rotation.y ?? 0;
      values[o + TransformLayout.rotation + 2] = rotation.z ?? 0;
      values[o + TransformLayout.rotation + 3] = rotation.w ?? 1;
    }
    if (scale) {
      values[o + TransformLayout.scale] = scale.x ?? 1;
      values[o + TransformLayout.scale + 1] = scale.y ?? 1;
      values[o + TransformLayout.scale + 2] = scale.z ?? 1;
    }
  }

  /**
   * The transform of a block owned by another (the node of a scene, its
   * entity): not freed by the transform; its owner detaches it when the
   * block is not its anymore.
   */
  static of(pool: TransformPool, index: number): Transform {
    return new Transform(undefined, pool, index);
  }

  /** The block of the transform in its pool. */
  get index(): number {
    if (this._index < 0) {
      throw new Error('The transform was disposed');
    }
    return this._index;
  }

  /**
   * @internal For the owner of the block: the transform cannot be used
   * anymore, the block is not freed.
   */
  detach(): void {
    this._index = -1;
  }

  /** Incremented at each change. */
  get version(): number {
    return this.pool.localVersion(this.index);
  }

  get position(): PooledVec3 {
    return this._position;
  }

  set position(value: Partial<IVec3>) {
    this.writeVec3(TransformLayout.position, value);
  }

  get rotation(): PooledQuat {
    return this._rotation;
  }

  set rotation({ x, y, z, w }: Partial<IQuat>) {
    const index = this.index;
    const data = this.pool.data;
    const o = index * stride + TransformLayout.rotation;
    if (x !== undefined) data[o] = x;
    if (y !== undefined) data[o + 1] = y;
    if (z !== undefined) data[o + 2] = z;
    if (w !== undefined) data[o + 3] = w;
    this.pool.touch(index);
  }

  get scale(): PooledVec3 {
    return this._scale;
  }

  set scale(value: Partial<IVec3>) {
    this.writeVec3(TransformLayout.scale, value);
  }

  /** Gives the block back to the pool: the transform cannot be used anymore. */
  dispose(): void {
    // The blocks owned by another are freed by their owner.
    if (this._index >= 0 && !this._owned) {
      registry.unregister(this);
      this.pool.free(this._index);
      this._index = -1;
    }
  }

  // Writes the components given, then signals one change.
  private writeVec3(offset: number, { x, y, z }: Partial<IVec3>): void {
    const index = this.index;
    const data = this.pool.data;
    const o = index * stride + offset;
    if (x !== undefined) data[o] = x;
    if (y !== undefined) data[o + 1] = y;
    if (z !== undefined) data[o + 2] = z;
    this.pool.touch(index);
  }
}
