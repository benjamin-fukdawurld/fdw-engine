import { LayoutApi } from '@fdw/engine-backend';

export const uniformLayout: LayoutApi = {
  bool: { size: 4, alignment: 4, stride: 4 },
  int32: { size: 4, alignment: 4, stride: 4 },
  uint32: { size: 4, alignment: 4, stride: 4 },
  float32: { size: 4, alignment: 4, stride: 4 },
  vec2: { size: 8, alignment: 8, stride: 8 },
  vec2i: { size: 8, alignment: 8, stride: 8 },
  vec2u: { size: 8, alignment: 8, stride: 8 },
  vec3: { size: 12, alignment: 16, stride: 16 },
  vec3i: { size: 12, alignment: 16, stride: 16 },
  vec3u: { size: 12, alignment: 16, stride: 16 },
  vec4: { size: 16, alignment: 16, stride: 16 },
  vec4i: { size: 16, alignment: 16, stride: 16 },
  vec4u: { size: 16, alignment: 16, stride: 16 },
  quat: { size: 16, alignment: 16, stride: 16 },
  mat2: { size: 16, alignment: 8, stride: 16 },
  mat3: { size: 48, alignment: 16, stride: 48 },
  mat4: { size: 64, alignment: 16, stride: 64 },
};
