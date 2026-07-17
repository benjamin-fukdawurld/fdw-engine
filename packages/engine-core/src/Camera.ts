import { Quat, SpatialTransformData, Vec3 } from './types';

export type PerspectiveProjectionData = {
  type: 'perspective';
  fov: number;
  aspect: number;
  near: number;
  far: number;
};

export type OrthographicProjectionData = {
  type: 'orthographic';
  left: number;
  right: number;
  bottom: number;
  top: number;
  near: number;
  far: number;
};

export type ProjectionData =
  | PerspectiveProjectionData
  | OrthographicProjectionData;

export type CameraData = SpatialTransformData & {
  projection: ProjectionData;
};

export type CameraState = {
  transformVersion: number;
  projectionVersion: number;
};

export type CameraSnapshot = Readonly<CameraState> & Readonly<CameraData>;

export class Camera {
  private _position: Vec3;
  private _rotation: Quat;
  private _projection: ProjectionData;

  private _transformVersion: number;
  private _projectionVersion: number;

  constructor(data?: CameraData) {
    this._position = data?.position ?? { x: 0, y: 0, z: 0 };
    this._rotation = data?.rotation ?? { x: 0, y: 0, z: 0, w: 1 };
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

  public get position(): Vec3 {
    return Object.freeze({ ...this._position });
  }

  public set position(value: Partial<Vec3>) {
    this._position.x = value.x ?? this._position.x;
    this._position.y = value.y ?? this._position.y;
    this._position.z = value.z ?? this._position.z;
    this._transformVersion++;
  }

  public get rotation(): Quat {
    return Object.freeze({ ...this._rotation });
  }

  public set rotation(value: Partial<Quat>) {
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
