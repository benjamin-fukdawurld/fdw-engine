import {
  CameraData,
  IVec3,
  IQuat,
  ProjectionData,
  QuatView,
  Vec3View,
  CameraSnapshot,
} from '@fdw/engine-backend';
import { TrackedQuatView, TrackedVec3View } from './trackedViews';

const defaultProjection: ProjectionData = {
  type: 'perspective',
  fov: 45,
  aspect: 1.0,
  near: 0.1,
  far: 100.0,
};

export class Camera implements CameraSnapshot {
  // Written through these views or the setters, the transform version is
  // incremented.
  private _position: Vec3View;
  private _rotation: QuatView;
  private _projection: ProjectionData;

  private _transformVersion = 0;
  private _projectionVersion = 0;

  constructor(data?: Partial<CameraData>) {
    const buffer = new ArrayBuffer((3 + 4) * 4);
    const changed = () => this._transformVersion++;
    this._position = new TrackedVec3View(buffer, 0, changed);
    this._position.x = data?.position?.x ?? 0;
    this._position.y = data?.position?.y ?? 0;
    this._position.z = data?.position?.z ?? 0;

    this._rotation = new TrackedQuatView(buffer, 3 * 4, changed);
    this._rotation.x = data?.rotation?.x ?? 0;
    this._rotation.y = data?.rotation?.y ?? 0;
    this._rotation.z = data?.rotation?.z ?? 0;
    this._rotation.w = data?.rotation?.w ?? 1;

    this._projection = { ...(data?.projection ?? defaultProjection) };

    // The initial values are version 0.
    this._transformVersion = 0;
  }

  public get transformVersion(): number {
    return this._transformVersion;
  }

  public get projectionVersion(): number {
    return this._projectionVersion;
  }

  /** The position; writing its components increments the version. */
  public get position(): Readonly<Vec3View> {
    return this._position;
  }

  public set position(value: Partial<IVec3>) {
    this._position.x = value.x ?? this._position.x;
    this._position.y = value.y ?? this._position.y;
    this._position.z = value.z ?? this._position.z;
  }

  /** The rotation; writing its components increments the version. */
  public get rotation(): Readonly<QuatView> {
    return this._rotation;
  }

  public set rotation(value: Partial<IQuat>) {
    this._rotation.x = value.x ?? this._rotation.x;
    this._rotation.y = value.y ?? this._rotation.y;
    this._rotation.z = value.z ?? this._rotation.z;
    this._rotation.w = value.w ?? this._rotation.w;
  }

  /** A frozen copy: assign a new projection to change it. */
  public get projection(): ProjectionData {
    return Object.freeze({ ...this._projection });
  }

  // Copied: changing the object given afterwards does not change the camera.
  public set projection(value: ProjectionData) {
    this._projection = { ...value };
    this._projectionVersion++;
  }
}
