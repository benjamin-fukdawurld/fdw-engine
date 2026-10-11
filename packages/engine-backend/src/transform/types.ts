import { SnapshotProvider } from '../utils/types';
import { TransformData } from '../types';
import { IQuat, IVec3, Mat3, Mat4 } from '../math';

export type TransformState = {
  version: number;
};

/** A vector that can be read as an array: a Vec3View, or a vector of a pool. */
export interface ArrayVec3 extends IVec3 {
  asArray(): Float32Array;
}

/** A quaternion that can be read as an array. */
export interface ArrayQuat extends IQuat {
  asArray(): Float32Array;
}

export type TransformSnapshot = Readonly<TransformState> &
  Readonly<TransformData> & {
    position: Readonly<ArrayVec3>;
    rotation: Readonly<ArrayQuat>;
    scale: Readonly<ArrayVec3>;
  };

export type TransformParentProvider = {
  readonly worldMatrix: SnapshotProvider<Mat4>;
  readonly worldNormalMatrix: SnapshotProvider<Mat3>;
};
