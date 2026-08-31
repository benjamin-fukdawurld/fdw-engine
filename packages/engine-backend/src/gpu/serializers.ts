import type { GpuSerializer } from './GpuSerializer';

export type SerializerApi = {
  bool: GpuSerializer;
  int32: GpuSerializer;
  uint32: GpuSerializer;
  float32: GpuSerializer;
  vec2: GpuSerializer;
  vec2i: GpuSerializer;
  vec2u: GpuSerializer;
  vec3: GpuSerializer;
  vec3i: GpuSerializer;
  vec3u: GpuSerializer;
  vec4: GpuSerializer;
  vec4i: GpuSerializer;
  vec4u: GpuSerializer;
  quat: GpuSerializer;
  mat2: GpuSerializer;
  mat3: GpuSerializer;
  mat4: GpuSerializer;
};
