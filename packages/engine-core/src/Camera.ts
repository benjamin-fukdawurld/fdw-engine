import {
  CameraData,
  IVec3,
  IQuat,
  ProjectionData,
  QuatView,
  Vec3View,
  CameraSnapshot,
} from '@fdw/engine-backend';

export class Camera implements CameraSnapshot {
  private _position: Vec3View;
  private _rotation: QuatView;
  private _projection: ProjectionData;

  private _transformVersion: number;
  private _projectionVersion: number;

  constructor(data?: CameraData) {
    const buffer = new ArrayBuffer((3 + 4) * 4);
    this._position = new Vec3View(buffer, 0);
    this._position.x = data?.position?.x ?? 0;
    this._position.y = data?.position?.y ?? 0;
    this._position.z = data?.position?.z ?? 0;

    this._rotation = new QuatView(buffer, 3 * 4);
    this._rotation.x = data?.rotation?.x ?? 0;
    this._rotation.y = data?.rotation?.y ?? 0;
    this._rotation.z = data?.rotation?.z ?? 0;
    this._rotation.w = data?.rotation?.w ?? 1;

    this._projection = data?.projection ?? {
      type: 'perspective',
      fov: 45,
      aspect: 1.0,
      near: 0.1,
      far: 100.0,
    };

    this._transformVersion = 0;
    this._projectionVersion = 0;
  }

  public get transformVersion(): number {
    return this._transformVersion;
  }

  public get projectionVersion(): number {
    return this._projectionVersion;
  }

  public get position(): Readonly<Vec3View> {
    return Object.freeze(this._position);
  }

  public set position(value: Partial<IVec3>) {
    this._position.x = value.x ?? this._position.x;
    this._position.y = value.y ?? this._position.y;
    this._position.z = value.z ?? this._position.z;
    this._transformVersion++;
  }

  public get rotation(): Readonly<QuatView> {
    return Object.freeze(this._rotation);
  }

  public set rotation(value: Partial<IQuat>) {
    this._rotation.x = value.x ?? this._rotation.x;
    this._rotation.y = value.y ?? this._rotation.y;
    this._rotation.z = value.z ?? this._rotation.z;
    this._rotation.w = value.w ?? this._rotation.w;
    this._transformVersion++;
  }

  public get projection(): ProjectionData {
    return Object.freeze({ ...this._projection });
  }

  public set projection(value: ProjectionData) {
    this._projection = value;
    this._projectionVersion++;
  }
}
