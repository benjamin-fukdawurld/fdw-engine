import { IVec2 } from './types';

export class Vec2View implements IVec2 {
  private _buffer: DataView;

  constructor(buffer?: ArrayBuffer, byteOffset?: number) {
    this._buffer = new DataView(
      buffer ?? new ArrayBuffer(2 * 4),
      byteOffset ?? 0
    );
  }

  get x(): number {
    return this._buffer.getFloat32(0, true);
  }

  set x(value: number) {
    this._buffer.setFloat32(0, value, true);
  }

  get y(): number {
    return this._buffer.getFloat32(4, true);
  }

  set y(value: number) {
    this._buffer.setFloat32(4, value, true);
  }

  asArray(): Float32Array {
    return new Float32Array(this._buffer.buffer, this._buffer.byteOffset, 2);
  }
}

export default Vec2View;
