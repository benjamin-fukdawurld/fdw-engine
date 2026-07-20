import { Mat4 } from 'wgpu-matrix';
import { CameraSnapshot } from './types';
import {
  CameraCache,
  ViewMatrixStrategy,
  ProjectionMatrixStrategy,
  ViewProjectionMatrixStrategy,
} from './CameraCache';
import { SnapshotProvider } from '../utils/types';
import { CachedValue } from '../utils';

export type CameraCreateMatrixBufferStrategy<TBuffer = unknown> = () => TBuffer;
export type CameraWriteMatrixBufferStrategy<TBuffer = unknown> = (
  buffer: TBuffer,
  data: Mat4
) => TBuffer;

export class CameraAdapter<TBuffer = unknown> {
  public readonly cameraCache: CameraCache;

  public readonly viewMatrixBuffer: CachedValue<
    TBuffer,
    [SnapshotProvider<Mat4>]
  >;
  public readonly projectionMatrixBuffer: CachedValue<
    TBuffer,
    [SnapshotProvider<Mat4>]
  >;
  public readonly viewProjectionMatrixBuffer: CachedValue<
    TBuffer,
    [SnapshotProvider<Mat4>, SnapshotProvider<Mat4>]
  >;

  constructor(options: {
    camera: CameraSnapshot;
    createMatrixBufferStrategy: CameraCreateMatrixBufferStrategy<TBuffer>;
    writeMatrixBufferStrategy: CameraWriteMatrixBufferStrategy<TBuffer>;
    viewMatrixStrategy: ViewMatrixStrategy;
    projectionMatrixStrategy: ProjectionMatrixStrategy;
    viewProjectionMatrixStrategy: ViewProjectionMatrixStrategy;
  }) {
    this.cameraCache = new CameraCache(
      options.camera,
      options.viewMatrixStrategy,
      options.projectionMatrixStrategy,
      options.viewProjectionMatrixStrategy
    );

    this.viewMatrixBuffer = new CachedValue<TBuffer, [SnapshotProvider<Mat4>]>({
      initialValue: options.createMatrixBufferStrategy(),
      updateStrategy: (buffer, dependencies) =>
        options.writeMatrixBufferStrategy(buffer, dependencies[0].value),
      dependencies: [this.cameraCache.viewMatrix],
    });

    this.projectionMatrixBuffer = new CachedValue<
      TBuffer,
      [SnapshotProvider<Mat4>]
    >({
      initialValue: options.createMatrixBufferStrategy(),
      updateStrategy: (buffer, dependencies) =>
        options.writeMatrixBufferStrategy(buffer, dependencies[0].value),
      dependencies: [this.cameraCache.projectionMatrix],
    });

    this.viewProjectionMatrixBuffer = new CachedValue<
      TBuffer,
      [SnapshotProvider<Mat4>, SnapshotProvider<Mat4>]
    >({
      initialValue: options.createMatrixBufferStrategy(),
      updateStrategy: (buffer, dependencies) =>
        options.writeMatrixBufferStrategy(
          buffer,
          options.viewProjectionMatrixStrategy(
            dependencies[0].value,
            dependencies[1].value
          )
        ),
      dependencies: [
        this.cameraCache.viewMatrix,
        this.cameraCache.projectionMatrix,
      ],
    });
  }
}
