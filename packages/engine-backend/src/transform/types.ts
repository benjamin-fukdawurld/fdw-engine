import { SnapshotProvider } from '../utils/types';
import { TransformData } from '../types';
import { Mat3, Mat4, QuatView, Vec3View } from '../math';

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
