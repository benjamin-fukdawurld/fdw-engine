import { Vec3 } from '../common';

export type ProjectionMode = 'perspective' | 'orthographic';

export type Camera = {
  position: Vec3;
  target: Vec3;
  up: Vec3;
};

export type Projection = {
  mode: ProjectionMode;
  near: number;
  far: number;
} & (
  | {
      mode: 'perspective';
      fovY: number;
      aspect: number;
    }
  | {
      mode: 'orthographic';
      left: number;
      right: number;
      bottom: number;
      top: number;
    }
);
