import { Mat4 } from 'wgpu-matrix';
import { CameraSnapshot, CameraState } from './Camera';

export class CameraCache {
  public readonly camera: CameraSnapshot;

  private _viewMatrix: Mat4;
  private _projectionMatrix: Mat4;
  private _viewProjectionMatrix: Mat4;

  private _transformVersion: number;
  private _projectionVersion: number;
  private _viewProjectionVersion: CameraState;

  public viewMatrixStrategy: (camera: CameraSnapshot) => Mat4;
  public projectionMatrixStrategy: (camera: CameraSnapshot) => Mat4;
  public viewProjectionMatrixStrategy: (
    camera: CameraSnapshot,
    cache: CameraCache
  ) => Mat4;

  constructor(
    camera: CameraSnapshot,
    viewMatrixStrategy: (camera: CameraSnapshot) => Mat4,
    projectionMatrixStrategy: (camera: CameraSnapshot) => Mat4,
    viewProjectionMatrixStrategy: (
      camera: CameraSnapshot,
      cache: CameraCache
    ) => Mat4
  ) {
    this.camera = camera;
    this.viewMatrixStrategy = viewMatrixStrategy;
    this.projectionMatrixStrategy = projectionMatrixStrategy;
    this.viewProjectionMatrixStrategy = viewProjectionMatrixStrategy;
    this._viewMatrix = this.viewMatrixStrategy(camera);
    this._projectionMatrix = this.projectionMatrixStrategy(camera);
    this._viewProjectionMatrix = this.viewProjectionMatrixStrategy(
      camera,
      this
    );
    this._transformVersion = this.camera.transformVersion;
    this._projectionVersion = this.camera.projectionVersion;
    this._viewProjectionVersion = {
      transformVersion: this.camera.transformVersion,
      projectionVersion: this.camera.projectionVersion,
    };
  }

  get transformDirty(): boolean {
    return this._transformVersion !== this.camera.transformVersion;
  }

  get projectionDirty(): boolean {
    return this._projectionVersion !== this.camera.projectionVersion;
  }

  get viewProjectionDirty(): boolean {
    return (
      this._viewProjectionVersion.transformVersion !==
        this.camera.transformVersion ||
      this._viewProjectionVersion.projectionVersion !==
        this.camera.projectionVersion
    );
  }

  get dirty(): boolean {
    return this.transformDirty || this.projectionDirty;
  }

  get viewMatrix(): Mat4 {
    this.updateViewMatrix();
    return this._viewMatrix;
  }

  get projectionMatrix(): Mat4 {
    this.updateProjectionMatrix();
    return this._projectionMatrix;
  }

  get viewProjectionMatrix(): Mat4 {
    if (this.dirty) {
      this._viewProjectionMatrix = this.viewProjectionMatrixStrategy(
        this.camera,
        this
      );
    }

    return this._viewProjectionMatrix;
  }

  updateViewMatrix(): void {
    if (this.transformDirty) {
      this._viewMatrix = this.viewMatrixStrategy(this.camera);
      this._transformVersion = this.camera.transformVersion;
    }
  }

  updateProjectionMatrix(): void {
    if (this.projectionDirty) {
      this._projectionMatrix = this.projectionMatrixStrategy(this.camera);
      this._projectionVersion = this.camera.projectionVersion;
    }
  }

  updateViewProjectionMatrix(): void {
    if (this.viewProjectionDirty) {
      this._viewProjectionMatrix = this.viewProjectionMatrixStrategy(
        this.camera,
        this
      );
      this._viewProjectionVersion.transformVersion =
        this.camera.transformVersion;
      this._viewProjectionVersion.projectionVersion =
        this.camera.projectionVersion;
    }
  }

  update(): void {
    this.updateViewMatrix();
    this.updateProjectionMatrix();
    this.updateViewProjectionMatrix();
  }
}
