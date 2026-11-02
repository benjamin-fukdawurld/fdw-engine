import { QuatView, Vec3View } from '@fdw/engine-backend';

// The vectors given by the getters of the cameras and lights: views over
// their buffer which call onChange when a component is written through
// them (`light.position.x = 1`), so that their owner increments its version.
// The arrays of asArray() are not tracked: write through the views or the
// setters of the owner.

/** A Vec3View calling onChange when written. */
export class TrackedVec3View extends Vec3View {
  constructor(
    buffer: ArrayBuffer,
    byteOffset: number,
    private readonly _onChange: () => void,
  ) {
    super(buffer, byteOffset);
  }

  override get x(): number {
    return super.x;
  }

  override set x(value: number) {
    super.x = value;
    this._onChange();
  }

  override get y(): number {
    return super.y;
  }

  override set y(value: number) {
    super.y = value;
    this._onChange();
  }

  override get z(): number {
    return super.z;
  }

  override set z(value: number) {
    super.z = value;
    this._onChange();
  }
}

/** A QuatView calling onChange when written. */
export class TrackedQuatView extends QuatView {
  constructor(
    buffer: ArrayBuffer,
    byteOffset: number,
    private readonly _onChange: () => void,
  ) {
    super(buffer, byteOffset);
  }

  override get x(): number {
    return super.x;
  }

  override set x(value: number) {
    super.x = value;
    this._onChange();
  }

  override get y(): number {
    return super.y;
  }

  override set y(value: number) {
    super.y = value;
    this._onChange();
  }

  override get z(): number {
    return super.z;
  }

  override set z(value: number) {
    super.z = value;
    this._onChange();
  }

  override get w(): number {
    return super.w;
  }

  override set w(value: number) {
    super.w = value;
    this._onChange();
  }
}
