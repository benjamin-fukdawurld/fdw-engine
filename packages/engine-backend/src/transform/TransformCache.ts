import { TransformParentProvider, TransformSnapshot } from './types';
import { SnapshotValue, CachedValue, SnapshotProvider } from '../utils';
import { mat3, mat4 } from 'wgpu-matrix';
import { TransformMath } from '../math/TransformMath';
import { Mat3, Mat4 } from '../math';

export class TransformCache implements TransformParentProvider {
  public readonly transform: TransformSnapshot;

  public readonly transformParentProvider?: TransformParentProvider;

  public readonly localMatrix: CachedValue<
    Mat4,
    [SnapshotProvider<TransformSnapshot>]
  >;

  public readonly inverseLocalMatrix: CachedValue<
    Mat4,
    [SnapshotProvider<Mat4>]
  >;

  public readonly normalMatrix: CachedValue<Mat3, [SnapshotProvider<Mat4>]>;

  public readonly worldMatrix: CachedValue<Mat4, SnapshotProvider<Mat4>[]>;

  public readonly worldNormalMatrix: CachedValue<
    Mat3,
    SnapshotProvider<Mat3>[]
  >;

  constructor({
    transform,
    transformParentProvider,
    transformMath,
  }: {
    transform: TransformSnapshot;
    transformParentProvider?: TransformParentProvider;
    transformMath: TransformMath;
  }) {
    this.transform = transform;
    this.transformParentProvider = transformParentProvider;

    this.localMatrix = new CachedValue<
      Mat4,
      [SnapshotProvider<TransformSnapshot>]
    >({
      initialValue: new Float32Array(16),
      updateStrategy: (_, dependencies) => {
        const { position, rotation, scale } = dependencies[0].value;
        return transformMath.getLocalMatrix(
          position.asArray(),
          rotation.asArray(),
          scale.asArray()
        );
      },
      dependencies: [
        new SnapshotValue<TransformSnapshot>({
          valueGetter: () => this.transform,
          versionGetter: () => this.transform.version,
        }),
      ],
    });

    this.inverseLocalMatrix = new CachedValue<Mat4, [SnapshotProvider<Mat4>]>({
      initialValue: new Float32Array(16),
      updateStrategy: (_, dependencies) =>
        transformMath.getInverseLocalMatrix(dependencies[0].value),
      dependencies: [this.localMatrix],
    });

    this.normalMatrix = new CachedValue<Mat3, [SnapshotProvider<Mat4>]>({
      initialValue: new Float32Array(9),
      updateStrategy: (_, dependencies) =>
        transformMath.getLocalNormalMatrix(dependencies[0].value),
      dependencies: [this.localMatrix],
    });

    this.worldMatrix = new CachedValue<Mat4, SnapshotProvider<Mat4>[]>({
      initialValue: new Float32Array(16),
      updateStrategy: (_, dependencies) =>
        transformMath.getWorldMatrix(
          dependencies[0].value,
          transformParentProvider?.worldMatrix.value
        ),
      dependencies: [
        this.localMatrix,
        this.transformParentProvider?.worldMatrix ??
          new SnapshotValue<Mat4>({
            valueGetter: () => mat4.identity(),
            versionGetter: () => 0,
          }),
      ],
    });

    this.worldNormalMatrix = new CachedValue<Mat3, SnapshotProvider<Mat3>[]>({
      initialValue: new Float32Array(9),
      updateStrategy: (_, dependencies) =>
        transformMath.getWorldNormalMatrix(
          dependencies[0].value,
          transformParentProvider?.worldNormalMatrix.value
        ),
      dependencies: [
        this.normalMatrix,
        this.transformParentProvider?.worldNormalMatrix ??
          new SnapshotValue<Mat3>({
            valueGetter: () => mat3.identity(),
            versionGetter: () => 0,
          }),
      ],
    });
  }
}
