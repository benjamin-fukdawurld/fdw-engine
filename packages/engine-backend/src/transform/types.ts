import { SnapshotProvider } from '../utils/types';
import { Mat3, Mat4, TransformData } from '../types';

export type TransformState = {
  version: number;
};

export type TransformSnapshot = Readonly<TransformState> &
  Readonly<TransformData>;

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

export type TransformCreateMatrixBufferStrategy<TBuffer = unknown> = (
  type: 'mat3' | 'mat4'
) => TBuffer;
export type TransformWriteMatrixBufferStrategy<TBuffer = unknown> = (
  buffer: TBuffer,
  type: 'mat3' | 'mat4',
  data: Mat3 | Mat4
) => void;

export type TransformCacheStrategy = {
  localMatrixStrategy: LocalMatrixStrategy;
  inverseLocalMatrixStrategy: InverseLocalMatrixStrategy;
  normalMatrixStrategy: LocalNormalMatrixStrategy;
  worldMatrixStrategy: WorldMatrixStrategy;
  worldNormalMatrixStrategy: WorldNormalMatrixStrategy;
};
