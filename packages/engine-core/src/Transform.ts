import {
  TransformData,
  Quat,
  Vec3,
  TransformSnapshot,
} from '@fdw/engine-backend';

export class Transform implements TransformSnapshot {
  private _position: Vec3;
  private _rotation: Quat;
  private _scale: Vec3;

  private _version: number;

  constructor(data?: TransformData) {
    this._position = data?.position ?? { x: 0, y: 0, z: 0 };
    this._rotation = data?.rotation ?? { x: 0, y: 0, z: 0, w: 1 };
    this._scale = data?.scale ?? { x: 1, y: 1, z: 1 };

    this._version = 0;
  }

  public get version(): number {
    return this._version;
  }

  public get position(): Vec3 {
    return Object.freeze({ ...this._position });
  }

  public set position(value: Partial<Vec3>) {
    this._position.x = value.x ?? this._position.x;
    this._position.y = value.y ?? this._position.y;
    this._position.z = value.z ?? this._position.z;
    this._version++;
  }

  public get rotation(): Quat {
    return Object.freeze({ ...this._rotation });
  }

  public set rotation(value: Partial<Quat>) {
    this._rotation.x = value.x ?? this._rotation.x;
    this._rotation.y = value.y ?? this._rotation.y;
    this._rotation.z = value.z ?? this._rotation.z;
    this._rotation.w = value.w ?? this._rotation.w;
    this._version++;
  }

  public get scale(): Vec3 {
    return Object.freeze({ ...this._scale });
  }

  public set scale(value: Partial<Vec3>) {
    this._scale.x = value.x ?? this._scale.x;
    this._scale.y = value.y ?? this._scale.y;
    this._scale.z = value.z ?? this._scale.z;
    this._version++;
  }
}
