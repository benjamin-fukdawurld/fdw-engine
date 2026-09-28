import { IQuat, IVec3 } from './math';
export type { IVec2, IVec3, IVec4, IQuat } from './math';

export type SpatialTransformData = {
  position: IVec3;
  rotation: IQuat;
};

export type TransformData = SpatialTransformData & {
  scale: IVec3;
};
