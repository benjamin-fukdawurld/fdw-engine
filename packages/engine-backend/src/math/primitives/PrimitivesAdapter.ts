import { Mat3Api } from './mat3';
import { Mat4Api } from './mat4';
import { QuatApi } from './quat';
import { Vec2Api } from './vec2';
import { Vec3Api } from './vec3';
import { Vec4Api } from './vec4';

export type PrimitivesAdapter = {
  vec2: Vec2Api;
  vec3: Vec3Api;
  vec4: Vec4Api;
  quat: QuatApi;
  mat3: Mat3Api;
  mat4: Mat4Api;
};
