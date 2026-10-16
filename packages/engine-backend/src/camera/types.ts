import { QuatView, Vec3View } from '../math';
import { SpatialTransformData } from '../types';

export type PerspectiveProjectionData = {
  type: 'perspective';
  fov: number;
  aspect: number;
  near: number;
  far: number;
};

export type OrthographicProjectionData = {
  type: 'orthographic';
  left: number;
  right: number;
  bottom: number;
  top: number;
  near: number;
  far: number;
};

export type ProjectionData =
  PerspectiveProjectionData | OrthographicProjectionData;

export type CameraData = SpatialTransformData & {
  projection: ProjectionData;
};

export type CameraState = {
  transformVersion: number;
  projectionVersion: number;
};

export type CameraSnapshot = Readonly<CameraState> &
  Readonly<CameraData> & {
    position: Readonly<Vec3View>;
    rotation: Readonly<QuatView>;
  };
