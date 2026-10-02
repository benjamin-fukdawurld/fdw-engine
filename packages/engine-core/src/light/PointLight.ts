import {
  PointLightData,
  IVec3,
  LightAttenuationDataSize,
  PointLightSnapshot,
  Vec3View,
} from '@fdw/engine-backend';
import { BaseLight } from './BaseLight';

export class PointLight extends BaseLight implements PointLightSnapshot {
  private _position: Vec3View;

  private _attenuation: DataView<ArrayBuffer>;

  // Plain values: { position: { x, y, z }, ambient: … }.
  constructor(data?: Partial<Omit<PointLightData, 'type'>>) {
    super(
      'point',
      new ArrayBuffer(
        BaseLight.bufferSize + LightAttenuationDataSize + 3 * 4 // Vec3 for position, 3 floats, each float is 4 bytes
      ),
      data
    );
    this._position = new Vec3View(this._buffer, BaseLight.bufferSize);
    this.position = data?.position ?? { x: 0, y: 0, z: 0 };
    this._attenuation = new DataView(
      this._buffer,
      BaseLight.bufferSize + 3 * 4,
      3 * 4
    );
    this.constantAttenuation = data?.constantAttenuation ?? 1.0;
    this.linearAttenuation = data?.linearAttenuation ?? 0.0;
    this.quadraticAttenuation = data?.quadraticAttenuation ?? 0.0;
  }

  public get position(): Readonly<Vec3View> {
    return Object.freeze(this._position);
  }

  public set position(value: Partial<IVec3>) {
    this._position.x = value.x ?? this._position.x;
    this._position.y = value.y ?? this._position.y;
    this._position.z = value.z ?? this._position.z;
    this._version++;
  }

  public get constantAttenuation(): number {
    return this._attenuation.getFloat32(0, true);
  }

  public set constantAttenuation(value: number) {
    this._attenuation.setFloat32(0, value, true);
    this._version++;
  }

  public get linearAttenuation(): number {
    return this._attenuation.getFloat32(4, true);
  }

  public set linearAttenuation(value: number) {
    this._attenuation.setFloat32(4, value, true);
    this._version++;
  }

  public get quadraticAttenuation(): number {
    return this._attenuation.getFloat32(8, true);
  }

  public set quadraticAttenuation(value: number) {
    this._attenuation.setFloat32(8, value, true);
    this._version++;
  }
}

export default PointLight;
