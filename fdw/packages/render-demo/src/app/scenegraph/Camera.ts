import { mat4, vec3 } from 'wgpu-matrix';

export type Screen = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ProjectionType = 'ortho' | 'perspective';

export type CameraProps = {
  position?: Float32Array;
  target?: Float32Array;
  up?: Float32Array;

  near?: number;
  far?: number;
  screen?: Partial<Screen> & { width: number; height: number };
  fov?: number;
  projection?: ProjectionType;
};

export class Camera {
  private _position: Float32Array;
  private _target: Float32Array;
  private _up: Float32Array;

  private _near: number;
  private _far: number;
  private _screen: Screen;
  private _fov: number;
  private _projection: ProjectionType;

  private _viewMatrix: Float32Array;
  private _viewMatrixUpToDate: boolean;

  private _projectionMatrix: Float32Array;
  private _projectionMatrixUpToDate: boolean;

  constructor(props?: CameraProps) {
    this._position = props?.position ?? vec3.create(0, 0, 10);
    this._target = props?.target ?? vec3.create(0, 0, 0);
    this._up = props?.up ?? vec3.create(0, 1, 0);

    this._near = props?.near ?? 0.001;
    this._far = props?.far ?? 1000;

    const screen = props?.screen ?? ({} as Partial<Screen>);
    screen.x = screen.x ?? 0;
    screen.y = screen.y ?? 0;
    screen.width = screen.width ?? 1;
    screen.height = screen.height ?? 1;

    this._screen = screen as Screen;

    this._fov = props?.fov ?? Math.PI / 2;
    this._projection = props?.projection ?? 'perspective';

    this._viewMatrix = mat4.identity();
    this._viewMatrixUpToDate = false;

    this._projectionMatrix = mat4.identity();
    this._projectionMatrixUpToDate = false;
  }

  get position(): Float32Array {
    return this._position;
  }

  set position(value: Float32Array) {
    this._position = value;
    this._viewMatrixUpToDate = false;
  }

  get target(): Float32Array {
    return this._target;
  }

  set target(value: Float32Array) {
    this._target = value;
    this._viewMatrixUpToDate = false;
  }

  get up(): Float32Array {
    return this._up;
  }

  set up(value: Float32Array) {
    this._up = value;
    this._viewMatrixUpToDate = false;
  }

  get near(): number {
    return this._near;
  }

  set near(value: number) {
    this._near = value;
    this._projectionMatrixUpToDate = false;
  }

  get far(): number {
    return this._far;
  }

  set far(value: number) {
    this._far = value;
    this._projectionMatrixUpToDate = false;
  }

  get screen(): Screen {
    return this._screen;
  }

  set screen(value: Screen) {
    this._screen = value;
    this._projectionMatrixUpToDate = false;
  }

  get screenTop(): number {
    return this._screen.y;
  }

  set screenTop(value: number) {
    this._screen.y = value;
    this._projectionMatrixUpToDate = false;
  }

  get screenBottom(): number {
    return this._screen.y + this._screen.height;
  }

  set screenBottom(value: number) {
    this._screen.height = value - this._screen.y;
    this._projectionMatrixUpToDate = false;
  }

  get screenLeft(): number {
    return this._screen.x;
  }

  set screenLeft(value: number) {
    this._screen.x = value;
    this._projectionMatrixUpToDate = false;
  }

  get screenRight(): number {
    return this._screen.width;
  }

  set screenRight(value: number) {
    this._screen.width = value - this.screen.x;
    this._projectionMatrixUpToDate = false;
  }

  get fov(): number {
    return this._fov;
  }

  set fov(value: number) {
    this._fov = value;
    this._projectionMatrixUpToDate = false;
  }

  get projection(): ProjectionType {
    return this._projection;
  }

  set projection(value: ProjectionType) {
    this._projection = value;
    this._projectionMatrixUpToDate = false;
  }

  invalidate(options?: { view?: boolean; projection?: boolean }) {
    if (!options || (!options.view && !options.projection)) {
      this._viewMatrixUpToDate = false;
      this._projectionMatrixUpToDate = false;
      return;
    }

    if (options.view) {
      this._viewMatrixUpToDate = false;
    }

    if (options.projection) {
      this._projectionMatrixUpToDate = false;
    }
  }

  get viewMatrix(): Float32Array {
    if (!this._viewMatrixUpToDate) {
      this.updateViewMatrix();
    }

    return this._viewMatrix;
  }

  get projectionMatrix(): Float32Array {
    if (!this._projectionMatrixUpToDate) {
      this.updateProjectionMatrix();
    }

    return this._projectionMatrix;
  }

  private updateViewMatrix() {
    mat4.lookAt(this._viewMatrix, this.position, this.target, this.up);
    this._viewMatrixUpToDate = true;
  }

  private updateProjectionMatrix() {
    switch (this._projection) {
      case 'ortho':
        mat4.ortho(
          this.position[0] - this.screen.width / 2,
          this.position[0] + this.screen.width / 2,
          this.position[1] - this.screen.height / 2,
          this.position[1] + this.screen.height / 2,
          -this._far,
          this._far,
          this._projectionMatrix
        );
        break;

      case 'perspective':
        mat4.perspective(
          this._fov,
          this.screen.width / this.screen.height,
          -this._far,
          this._far,
          this._projectionMatrix
        );
        break;
    }
    this._projectionMatrixUpToDate = true;
  }
}

export default Camera;
