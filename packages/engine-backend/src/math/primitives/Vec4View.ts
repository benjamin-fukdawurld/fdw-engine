import { IVec4 } from './types';

export class Vec4View implements IVec4 {
  private _buffer: DataView<ArrayBuffer>;

  constructor(buffer?: ArrayBuffer, byteOffset?: number) {
    this._buffer = new DataView<ArrayBuffer>(
      buffer ?? new ArrayBuffer(4 * 4),
      byteOffset ?? 0,
    );
  }

  get buffer(): DataView<ArrayBuffer> {
    return this._buffer;
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

  get w(): number {
    return this._buffer.getFloat32(12, true);
  }

  set w(value: number) {
    this._buffer.setFloat32(12, value, true);
  }

  asArray(): Float32Array {
    return new Float32Array(this._buffer.buffer, this._buffer.byteOffset, 4);
  }

  set(arr: number[]): void {
    this.x = arr[0];
    this.y = arr[1];
    this.z = arr[2];
    this.w = arr[3];
  }
}

export default Vec4View;
