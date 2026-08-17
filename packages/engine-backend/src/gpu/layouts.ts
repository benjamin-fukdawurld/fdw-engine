import { GpuLayout } from './GpuLayout';

export type LayoutApi = {
  bool: GpuLayout;
  int32: GpuLayout;
  uint32: GpuLayout;
  float32: GpuLayout;
  vec2: GpuLayout;
  vec2i: GpuLayout;
  vec2u: GpuLayout;
  vec3: GpuLayout;
  vec3i: GpuLayout;
  vec3u: GpuLayout;
  vec4: GpuLayout;
  vec4i: GpuLayout;
  vec4u: GpuLayout;
  quat: GpuLayout;
  mat2: GpuLayout;
  mat3: GpuLayout;
  mat4: GpuLayout;
};
