import {
  BaseLightSnapshot,
  IVec3,
  LightColorDataSize,
  LightType,
  Vec3View,
} from '@fdw/engine-backend';

export class BaseLight implements BaseLightSnapshot {
  readonly type: LightType;

  protected _buffer: ArrayBuffer;
  private _ambient: Vec3View;
  private _diffuse: Vec3View;
  private _specular: Vec3View;

  protected _version: number;

  protected static readonly bufferSize: number = LightColorDataSize;

  protected constructor(
    type: LightType,
    buffer: ArrayBuffer,
    data?: Partial<BaseLightSnapshot>
  ) {
    this.type = type;
    this._buffer = buffer;
    this._ambient = new Vec3View(this._buffer, 0);
    this.ambient = data?.ambient ?? { x: 0.2, y: 0.2, z: 0.2 };
    this._diffuse = new Vec3View(this._buffer, 3 * 4);
    this.diffuse = data?.diffuse ?? { x: 0.5, y: 0.5, z: 0.5 };
    this._specular = new Vec3View(this._buffer, 6 * 4);
    this.specular = data?.specular ?? { x: 1.0, y: 1.0, z: 1.0 };
    this._version = 0;
  }

  public get version(): number {
    return this._version;
  }

  public get ambient(): Readonly<Vec3View> {
    return Object.freeze(this._ambient);
  }

  public set ambient(value: Partial<IVec3>) {
    this._ambient.x = value.x ?? this._ambient.x;
    this._ambient.y = value.y ?? this._ambient.y;
    this._ambient.z = value.z ?? this._ambient.z;
    this._version++;
  }

  public get diffuse(): Readonly<Vec3View> {
    return Object.freeze(this._diffuse);
  }

  public set diffuse(value: Partial<IVec3>) {
    this._diffuse.x = value.x ?? this._diffuse.x;
    this._diffuse.y = value.y ?? this._diffuse.y;
    this._diffuse.z = value.z ?? this._diffuse.z;
    this._version++;
  }

  public get specular(): Readonly<Vec3View> {
    return Object.freeze(this._specular);
  }

  public set specular(value: Partial<IVec3>) {
    this._specular.x = value.x ?? this._specular.x;
    this._specular.y = value.y ?? this._specular.y;
    this._specular.z = value.z ?? this._specular.z;
    this._version++;
  }
}

export default BaseLight;
