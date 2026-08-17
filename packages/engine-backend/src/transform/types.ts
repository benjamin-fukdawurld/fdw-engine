import { SnapshotProvider } from '../utils/types';
import { Mat3, Mat4, TransformData } from '../types';
import { QuatView, Vec3View } from '../math';

export type TransformState = {
  version: number;
};

export type TransformSnapshot = Readonly<TransformState> &
  Readonly<TransformData> & {
    position: Readonly<Vec3View>;
    rotation: Readonly<QuatView>;
    scale: Readonly<Vec3View>;
  };

export type TransformParentProvider = {
  readonly worldMatrix: SnapshotProvider<Mat4>;
  readonly worldNormalMatrix: SnapshotProvider<Mat3>;
};

export type LocalMatrixStrategy = (transform: TransformSnapshot) => Mat4;
export type InverseLocalMatrixStrategy = (localMatrix: Mat4) => Mat4;
export type LocalNormalMatrixStrategy = (localMatrix: Mat4) => Mat3;

export type WorldMatrixStrategy = (
  localMatrix: Mat4,
  parentWorldMatrix?: Mat4
) => Mat4;
export type WorldNormalMatrixStrategy = (
  normalMatrix: Mat3,
  parentWorldNormalMatrix?: Mat3
) => Mat3;
