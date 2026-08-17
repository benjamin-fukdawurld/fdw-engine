import { IVec3 } from './types';

export class Vec3View implements IVec3 {
  private _buffer: DataView;

  constructor(buffer?: ArrayBuffer, byteOffset?: number) {
    this._buffer = new DataView(
      buffer ?? new ArrayBuffer(3 * 4),
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

  get z(): number {
    return this._buffer.getFloat32(8, true);
  }

  set z(value: number) {
    this._buffer.setFloat32(8, value, true);
  }

  asArray(): Float32Array {
    return new Float32Array(this._buffer.buffer, this._buffer.byteOffset, 3);
  }
}

export default Vec3View;
