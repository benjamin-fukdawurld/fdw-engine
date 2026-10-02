import {
  TransformData,
  TransformSnapshot,
  Vec3View,
  QuatView,
  IVec3,
  IQuat,
} from '@fdw/engine-backend';

export class Transform implements TransformSnapshot {
  private _position: Vec3View;
  private _rotation: QuatView;
  private _scale: Vec3View;

  private _version: number;

  constructor(data?: Partial<TransformData>) {
    const buffer = new ArrayBuffer((3 + 4 + 3) * 4);
    this._position = new Vec3View(buffer, 0);
    this._rotation = new QuatView(buffer, 3 * 4);
    this._scale = new Vec3View(buffer, (3 + 4) * 4);

    this._position.x = data?.position?.x ?? 0;
    this._position.y = data?.position?.y ?? 0;
    this._position.z = data?.position?.z ?? 0;

    this._rotation.x = data?.rotation?.x ?? 0;
    this._rotation.y = data?.rotation?.y ?? 0;
    this._rotation.z = data?.rotation?.z ?? 0;
    this._rotation.w = data?.rotation?.w ?? 1;

    this._scale.x = data?.scale?.x ?? 1;
    this._scale.y = data?.scale?.y ?? 1;
    this._scale.z = data?.scale?.z ?? 1;

    this._version = 0;
  }

  public get version(): number {
    return this._version;
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

  public get rotation(): Readonly<QuatView> {
    return Object.freeze(this._rotation);
  }

  public set rotation(value: Partial<IQuat>) {
    this._rotation.x = value.x ?? this._rotation.x;
    this._rotation.y = value.y ?? this._rotation.y;
    this._rotation.z = value.z ?? this._rotation.z;
    this._rotation.w = value.w ?? this._rotation.w;
    this._version++;
  }

  public get scale(): Readonly<Vec3View> {
    return Object.freeze(this._scale);
  }

  public set scale(value: Partial<IVec3>) {
    this._scale.x = value.x ?? this._scale.x;
    this._scale.y = value.y ?? this._scale.y;
    this._scale.z = value.z ?? this._scale.z;
    this._version++;
  }
}
