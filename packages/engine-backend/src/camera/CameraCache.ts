import { Mat4 } from 'wgpu-matrix';
import { CameraSnapshot } from './types';
import { CachedValue, SnapshotProvider, SnapshotValue } from '../utils';
import { CameraMath } from '../math';

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

  constructor(camera: CameraSnapshot, cameraMath: CameraMath) {
    this.camera = camera;
    this.viewMatrix = new CachedValue<Mat4, [SnapshotProvider<CameraSnapshot>]>(
      {
        initialValue: new Float32Array(16),
        updateStrategy: (_, dependencies) =>
          cameraMath.getViewMatrix(
            dependencies[0].value.position.asArray(),
            dependencies[0].value.rotation.asArray()
          ),
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
        cameraMath.getProjectionMatrix(dependencies[0].value.projection),
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
        cameraMath.getViewProjectionMatrix(
          dependencies[0].value,
          dependencies[1].value
        ),
      dependencies: [this.viewMatrix, this.projectionMatrix],
    });
  }
}
