import { IColor } from './types';

export class ColorView implements IColor {
  private _buffer: DataView<ArrayBuffer>;

  constructor(buffer?: ArrayBuffer, byteOffset?: number) {
    this._buffer = new DataView<ArrayBuffer>(
      buffer ?? new ArrayBuffer(4 * 4),
      byteOffset ?? 0
    );
  }

  get buffer(): DataView<ArrayBuffer> {
    return this._buffer;
  }

  get r(): number {
    return this._buffer.getFloat32(0, true);
  }

  set r(value: number) {
    this._buffer.setFloat32(0, value, true);
  }

  get g(): number {
    return this._buffer.getFloat32(4, true);
  }

  set g(value: number) {
    this._buffer.setFloat32(4, value, true);
  }

  get b(): number {
    return this._buffer.getFloat32(8, true);
  }

  set b(value: number) {
    this._buffer.setFloat32(8, value, true);
  }

  get a(): number {
    return this._buffer.getFloat32(12, true);
  }

  set a(value: number) {
    this._buffer.setFloat32(12, value, true);
  }

  asArray(): Float32Array {
    return new Float32Array(this._buffer.buffer, this._buffer.byteOffset, 4);
  }

  set(arr: number[]): void {
    this.r = arr[0];
    this.g = arr[1];
    this.b = arr[2];
    this.a = arr[3];
  }
}

export default ColorView;
