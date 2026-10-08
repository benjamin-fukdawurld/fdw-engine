import {
  CameraMath,
  TransformMath,
  wgpuMatrixPrimitives,
} from '@fdw/engine-backend';

export const { vec2, vec3, vec4, quat, mat3, mat4 } = wgpuMatrixPrimitives;

export const transformMath = new TransformMath(wgpuMatrixPrimitives);

export const cameraMath = new CameraMath(wgpuMatrixPrimitives);
