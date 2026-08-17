import { QuatView, Vec2View, Vec3View, Vec4View } from '../math';
import { GpuArray } from './GpuArray';
import { GpuLayout } from './GpuLayout';
import { GpuWriter } from './GpuWriter';
import { LayoutApi } from './layouts';
import { primitiveOf } from './primitives';
import { WriterApi } from './writers';

export type ArrayApi = {
  bool: GpuArray<boolean>;
  int32: GpuArray<number>;
  uint32: GpuArray<number>;
  float32: GpuArray<number>;
  vec2: GpuArray<Vec2View>;
  vec2i: GpuArray<Vec2View>;
  vec2u: GpuArray<Vec2View>;
  vec3: GpuArray<Vec3View>;
  vec3i: GpuArray<Vec3View>;
  vec3u: GpuArray<Vec3View>;
  vec4: GpuArray<Vec4View>;
  vec4i: GpuArray<Vec4View>;
  vec4u: GpuArray<Vec4View>;
  quat: GpuArray<QuatView>;
  mat2: GpuArray<Float32Array>;
  mat3: GpuArray<Float32Array>;
  mat4: GpuArray<Float32Array>;
};

export function arrayOf<T>({
  layout,
  writer,
  length,
}: {
  layout: GpuLayout;
  writer: GpuWriter<T>;
  length?: number;
}): GpuArray<T> {
  return {
    element: primitiveOf({ layout, writer }),
    stride: layout.stride,
    length,
    write: (target: ArrayBuffer, offset: number, value: T[]): void => {
      for (let i = 0, imax = length ?? value.length; i < imax; i++) {
        writer.write(target, offset + i * layout.stride, value[i]);
      }
    },
  };
}

export function arrayApi({
  layouts,
  writers,
}: {
  layouts: LayoutApi;
  writers: WriterApi;
}): ArrayApi {
  return {
    bool: arrayOf<boolean>({ layout: layouts.bool, writer: writers.bool }),
    int32: arrayOf<number>({ layout: layouts.int32, writer: writers.int32 }),
    uint32: arrayOf<number>({ layout: layouts.uint32, writer: writers.uint32 }),
    float32: arrayOf<number>({
      layout: layouts.float32,
      writer: writers.float32,
    }),
    vec2: arrayOf<Vec2View>({ layout: layouts.vec2, writer: writers.vec2 }),
    vec2i: arrayOf<Vec2View>({ layout: layouts.vec2i, writer: writers.vec2i }),
    vec2u: arrayOf<Vec2View>({ layout: layouts.vec2u, writer: writers.vec2u }),
    vec3: arrayOf<Vec3View>({ layout: layouts.vec3, writer: writers.vec3 }),
    vec3i: arrayOf<Vec3View>({ layout: layouts.vec3i, writer: writers.vec3i }),
    vec3u: arrayOf<Vec3View>({ layout: layouts.vec3u, writer: writers.vec3u }),
    vec4: arrayOf<Vec4View>({ layout: layouts.vec4, writer: writers.vec4 }),
    vec4i: arrayOf<Vec4View>({ layout: layouts.vec4i, writer: writers.vec4i }),
    vec4u: arrayOf<Vec4View>({ layout: layouts.vec4u, writer: writers.vec4u }),
    quat: arrayOf<QuatView>({ layout: layouts.quat, writer: writers.quat }),
    mat2: arrayOf<Float32Array>({ layout: layouts.mat2, writer: writers.mat2 }),
    mat3: arrayOf<Float32Array>({ layout: layouts.mat3, writer: writers.mat3 }),
    mat4: arrayOf<Float32Array>({ layout: layouts.mat4, writer: writers.mat4 }),
  };
}
