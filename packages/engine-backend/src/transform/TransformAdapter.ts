import { Mat3, Mat4 } from 'wgpu-matrix';
import {
  TransformCreateMatrixBufferStrategy,
  InverseLocalMatrixStrategy,
  LocalMatrixStrategy,
  LocalNormalMatrixStrategy,
  TransformSnapshot,
  WorldMatrixStrategy,
  WorldNormalMatrixStrategy,
  TransformWriteMatrixBufferStrategy,
} from './types';
import { TransformCache } from './TransformCache';
import { SnapshotProvider } from '../utils';
import CachedValue from '../utils/CachedValue';

export class TransformAdapter<TBuffer = unknown> {
  public readonly transformCache: TransformCache;

  public readonly localMatrixBuffer: CachedValue<
    TBuffer | undefined,
    [SnapshotProvider<Mat4>]
  >;
  public readonly inverseLocalMatrixBuffer: CachedValue<
    TBuffer | undefined,
    [SnapshotProvider<Mat4>]
  >;
  public readonly normalMatrixBuffer: CachedValue<
    TBuffer | undefined,
    [SnapshotProvider<Mat3>]
  >;
  public readonly worldMatrixBuffer: CachedValue<
    TBuffer | undefined,
    [SnapshotProvider<Mat4>]
  >;
  public readonly worldNormalMatrixBuffer: CachedValue<
    TBuffer | undefined,
    [SnapshotProvider<Mat3>]
  >;

  constructor(options: {
    transform: TransformSnapshot;
    localMatrixStrategy: LocalMatrixStrategy;
    inverseLocalMatrixStrategy: InverseLocalMatrixStrategy;
    normalMatrixStrategy: LocalNormalMatrixStrategy;
    worldMatrixStrategy: WorldMatrixStrategy;
    worldNormalMatrixStrategy: WorldNormalMatrixStrategy;
    createMatrixBufferStrategy: TransformCreateMatrixBufferStrategy<TBuffer>;
    writeMatrixBufferStrategy: TransformWriteMatrixBufferStrategy<TBuffer>;
  }) {
    const updateBuffer = (
      buffer: TBuffer | undefined,
      type: 'mat3' | 'mat4',
      matrix: Mat4 | Mat3
    ): TBuffer => {
      if (!buffer) {
        buffer = options.createMatrixBufferStrategy(type);
      }
      options.writeMatrixBufferStrategy(buffer, type, matrix);

      return buffer;
    };

    this.transformCache = new TransformCache({
      ...options,
    });

    this.localMatrixBuffer = new CachedValue<
      TBuffer | undefined,
      [SnapshotProvider<Mat4>]
    >({
      initialValue: undefined,
      updateStrategy: (buffer, dependencies) =>
        updateBuffer(buffer, 'mat4', dependencies[0].value),
      dependencies: [this.transformCache.localMatrix],
    });
    this.inverseLocalMatrixBuffer = new CachedValue<
      TBuffer | undefined,
      [SnapshotProvider<Mat4>]
    >({
      initialValue: undefined,
      updateStrategy: (buffer, dependencies) =>
        updateBuffer(buffer, 'mat4', dependencies[0].value),
      dependencies: [this.transformCache.inverseLocalMatrix],
    });
    this.normalMatrixBuffer = new CachedValue<
      TBuffer | undefined,
      [SnapshotProvider<Mat3>]
    >({
      initialValue: undefined,
      updateStrategy: (buffer, dependencies) =>
        updateBuffer(buffer, 'mat3', dependencies[0].value),
      dependencies: [this.transformCache.normalMatrix],
    });
    this.worldMatrixBuffer = new CachedValue<
      TBuffer | undefined,
      [SnapshotProvider<Mat4>]
    >({
      initialValue: undefined,
      updateStrategy: (buffer, dependencies) =>
        updateBuffer(buffer, 'mat4', dependencies[0].value),
      dependencies: [this.transformCache.worldMatrix],
    });
    this.worldNormalMatrixBuffer = new CachedValue<
      TBuffer | undefined,
      [SnapshotProvider<Mat3>]
    >({
      initialValue: undefined,
      updateStrategy: (buffer, dependencies) =>
        updateBuffer(buffer, 'mat3', dependencies[0].value),
      dependencies: [this.transformCache.worldNormalMatrix],
    });
  }
}
