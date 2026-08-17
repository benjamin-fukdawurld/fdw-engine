import { QuatView, Vec2View, Vec3View, Vec4View } from '../math';
import type { GpuWriter } from './GpuWriter';

export type WriterApi = {
  bool: GpuWriter<boolean>;
  int32: GpuWriter<number>;
  uint32: GpuWriter<number>;
  float32: GpuWriter<number>;
  vec2: GpuWriter<Vec2View>;
  vec2i: GpuWriter<Vec2View>;
  vec2u: GpuWriter<Vec2View>;
  vec3: GpuWriter<Vec3View>;
  vec3i: GpuWriter<Vec3View>;
  vec3u: GpuWriter<Vec3View>;
  vec4: GpuWriter<Vec4View>;
  vec4i: GpuWriter<Vec4View>;
  vec4u: GpuWriter<Vec4View>;
  quat: GpuWriter<QuatView>;
  mat2: GpuWriter<Float32Array>;
  mat3: GpuWriter<Float32Array>;
  mat4: GpuWriter<Float32Array>;
};
