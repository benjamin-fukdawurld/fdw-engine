import { Mat4 } from 'wgpu-matrix';
import { CameraSnapshot, CameraState } from './types';
import { CachedValue, SnapshotProvider, SnapshotValue } from '../utils';

export type ViewMatrixStrategy = (camera: CameraSnapshot) => Mat4;
export type ProjectionMatrixStrategy = (camera: CameraSnapshot) => Mat4;
export type ViewProjectionMatrixStrategy = (
  viewMatrix: Mat4,
  projectionMatrix: Mat4
) => Mat4;

export class CameraCache {
  public camera: CameraSnapshot;

  public readonly viewMatrix: CachedValue<
    Mat4,
    [SnapshotProvider<CameraSnapshot>]
  >;
  public readonly projectionMatrix: CachedValue<
    Mat4,
    [SnapshotProvider<CameraSnapshot>]
  >;
  public readonly viewProjectionMatrix: CachedValue<
    Mat4,
    [SnapshotProvider<Mat4>, SnapshotProvider<Mat4>]
  >;

  constructor(
    camera: CameraSnapshot,
    viewMatrixStrategy: ViewMatrixStrategy,
    projectionMatrixStrategy: ProjectionMatrixStrategy,
    viewProjectionMatrixStrategy: ViewProjectionMatrixStrategy
  ) {
    this.camera = camera;
    this.viewMatrix = new CachedValue<Mat4, [SnapshotProvider<CameraSnapshot>]>(
      {
        initialValue: new Float32Array(16),
        updateStrategy: (_, dependencies) =>
          viewMatrixStrategy(dependencies[0].value),
        dependencies: [
          new SnapshotValue<CameraSnapshot>({
            valueGetter: () => this.camera,
            versionGetter: () => this.camera.transformVersion,
          }),
        ],
      }
    );

    this.projectionMatrix = new CachedValue<
      Mat4,
      [SnapshotProvider<CameraSnapshot>]
    >({
      initialValue: new Float32Array(16),
      updateStrategy: (_, dependencies) =>
        projectionMatrixStrategy(dependencies[0].value),
      dependencies: [
        new SnapshotValue<CameraSnapshot>({
          valueGetter: () => this.camera,
          versionGetter: () => this.camera.projectionVersion,
        }),
      ],
    });

    this.viewProjectionMatrix = new CachedValue<
      Mat4,
      [SnapshotProvider<Mat4>, SnapshotProvider<Mat4>]
    >({
      initialValue: new Float32Array(16),
      updateStrategy: (_, dependencies) =>
        viewProjectionMatrixStrategy(
          dependencies[0].value,
          dependencies[1].value
        ),
      dependencies: [this.viewMatrix, this.projectionMatrix],
    });
  }
}
