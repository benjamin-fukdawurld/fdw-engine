import { Mat3, Mat4 } from '../math';
import { TransformSnapshot } from './types';
import { TransformCache } from './TransformCache';
import { SnapshotProvider } from '../utils';
import CachedValue from '../utils/CachedValue';
import { TransformMath } from '../math/TransformMath';
import { GpuBuffer, GpuBufferFactory } from '../gpu';

export class TransformAdapter {
  public readonly transformCache: TransformCache;

  public readonly localMatrixBuffer: CachedValue<
    GpuBuffer | undefined,
    [SnapshotProvider<Mat4>]
  >;
  public readonly inverseLocalMatrixBuffer: CachedValue<
    GpuBuffer | undefined,
    [SnapshotProvider<Mat4>]
  >;
  public readonly normalMatrixBuffer: CachedValue<
    GpuBuffer | undefined,
    [SnapshotProvider<Mat3>]
  >;
  public readonly worldMatrixBuffer: CachedValue<
    GpuBuffer | undefined,
    [SnapshotProvider<Mat4>]
  >;
  public readonly worldNormalMatrixBuffer: CachedValue<
    GpuBuffer | undefined,
    [SnapshotProvider<Mat3>]
  >;

  constructor(options: {
    transform: TransformSnapshot;
    transformMath: TransformMath;
    bufferFactory: GpuBufferFactory;
  }) {
    const updateBuffer = (
      buffer: GpuBuffer | undefined,
      type: 'mat3' | 'mat4',
      matrix: Mat4 | Mat3
    ): GpuBuffer => {
      if (!buffer) {
        buffer = options.bufferFactory.create({
          size: type === 'mat4' ? 16 * 4 : 12 * 4, // 4x4 or 3x3 matrix, 4 bytes per float
          usage: ['uniform', 'copy-dst'],
        });
      }
      buffer.write(0, new Float32Array(matrix).buffer);

      return buffer;
    };

    this.transformCache = new TransformCache({
      ...options,
    });

    this.localMatrixBuffer = new CachedValue<
      GpuBuffer | undefined,
      [SnapshotProvider<Mat4>]
    >({
      initialValue: undefined,
      updateStrategy: (buffer, dependencies) =>
        updateBuffer(buffer, 'mat4', dependencies[0].value),
      dependencies: [this.transformCache.localMatrix],
    });
    this.inverseLocalMatrixBuffer = new CachedValue<
      GpuBuffer | undefined,
      [SnapshotProvider<Mat4>]
    >({
      initialValue: undefined,
      updateStrategy: (buffer, dependencies) =>
        updateBuffer(buffer, 'mat4', dependencies[0].value),
      dependencies: [this.transformCache.inverseLocalMatrix],
    });
    this.normalMatrixBuffer = new CachedValue<
      GpuBuffer | undefined,
      [SnapshotProvider<Mat3>]
    >({
      initialValue: undefined,
      updateStrategy: (buffer, dependencies) =>
        updateBuffer(buffer, 'mat3', dependencies[0].value),
      dependencies: [this.transformCache.normalMatrix],
    });
    this.worldMatrixBuffer = new CachedValue<
      GpuBuffer | undefined,
      [SnapshotProvider<Mat4>]
    >({
      initialValue: undefined,
      updateStrategy: (buffer, dependencies) =>
        updateBuffer(buffer, 'mat4', dependencies[0].value),
      dependencies: [this.transformCache.worldMatrix],
    });
    this.worldNormalMatrixBuffer = new CachedValue<
      GpuBuffer | undefined,
      [SnapshotProvider<Mat3>]
    >({
      initialValue: undefined,
      updateStrategy: (buffer, dependencies) =>
        updateBuffer(buffer, 'mat3', dependencies[0].value),
      dependencies: [this.transformCache.worldNormalMatrix],
    });
  }
}
